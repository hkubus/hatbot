import { expect, test } from "bun:test";
import { anthropicPlugin } from "@hatbot/plugin-anthropic";
import { homeassistantPlugin } from "@hatbot/plugin-homeassistant";
import { openaiPlugin } from "@hatbot/plugin-openai";
import type { Me, Onboarding, SetupEvent, SetupItem } from "@hatbot/shared";
import { FakeModel, text, toolUse } from "./fake-model";
import { signIn, type TestApp, testApp, waitFor } from "./helpers";
import { stopPluginsAfterEach, track } from "./plugin-helpers";

stopPluginsAfterEach();

async function turn(t: TestApp, cookie: string, body: unknown) {
  const res = await t.call("POST", "/onboarding/turn", body, { cookie });
  if (res.status !== 200) return { status: res.status, events: [] as SetupEvent[] };
  const events = (await res.text())
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as SetupEvent);
  return { status: res.status, events };
}

const last = (events: SetupEvent[]) => {
  const s = events.at(-1);
  if (s?.type !== "state") throw new Error("no state at the end");
  return s.onboarding;
};

const sent = (m: FakeModel) => JSON.stringify(m.requests.at(-1)?.messages);

test("the interview changes settings, marks topics and asks with buttons; finishing forgets it", async () => {
  const model = new FakeModel([
    {
      content: [
        text("Hi! Let's start with you."),
        toolUse("change_settings", { changes: { owner: { name: "Ola", email: "owner@local" } } }),
        toolUse("topic", { topic: "you", state: "done" }),
      ],
    },
    { content: [toolUse("ask", { question: "Rename Hatbot?", choices: ["Keep it", "Rename"] })] },
    { content: [text("Kept. Press Finish when you like.")] },
  ]);
  const t = await testApp(model);
  const { cookie } = signIn(t);
  const me = async () =>
    (await (await t.call("GET", "/auth/me", undefined, { cookie })).json()) as Me;
  expect((await me()).onboarded).toBe(false);

  const first = await turn(t, cookie, { start: { timezone: "Europe/Warsaw" } });
  expect(JSON.stringify(model.requests[0]?.messages)).toContain("Europe/Warsaw");
  const state = last(first.events);
  expect(t.settings.get().owner.name).toBe("Ola");
  expect(state.topics.you).toBe("done");
  expect(state.items.map((i) => i.kind)).toEqual(["bot", "change", "bot"]);
  expect(state.items.at(-1)).toMatchObject({ choices: ["Keep it", "Rename"] });

  const second = await turn(t, cookie, { say: "Keep it" });
  // The answer is the ask's result.
  expect(sent(model)).toContain('"tool_result"');
  expect(sent(model)).toContain("Keep it");
  expect(last(second.events).items.at(-1)).toMatchObject({ kind: "bot" });

  const done = (await (
    await t.call("POST", "/onboarding/finish", undefined, { cookie })
  ).json()) as Onboarding;
  expect(done).toMatchObject({ finished: true, items: [] });
  expect((await me()).onboarded).toBe(true);
});

test("a key or token goes through a form, never through the model", async () => {
  const model = new FakeModel([
    { content: [toolUse("ask_secrets", { plugin: "homeassistant", why: "A long-lived token." })] },
    { content: [text("It works.")] },
  ]);
  const t = track(await testApp(model, undefined, {}, [homeassistantPlugin]));
  const { cookie } = signIn(t);
  await t.plugins.update("homeassistant", { enabled: true });
  const asked = last((await turn(t, cookie, { start: { timezone: "" } })).events);
  const form = asked.items.find(
    (i): i is Extract<SetupItem, { kind: "secrets" }> => i.kind === "secrets",
  );
  expect(form?.fields.map((f) => f.name)).toContain("HOMEASSISTANT_TOKEN");

  const after = await turn(t, cookie, {
    secrets: {
      id: form?.id,
      values: { HOMEASSISTANT_URL: "http://ha.lan:8123", HOMEASSISTANT_TOKEN: "very-secret-token" },
    },
  });
  expect(t.plugins.env().HOMEASSISTANT_TOKEN).toBe("very-secret-token");
  expect(JSON.stringify(model.requests)).not.toContain("very-secret-token");
  expect(last(after.events).items).toContainEqual(
    expect.objectContaining({ kind: "secrets", state: "saved" }),
  );

  // Answered once: the form is gone.
  expect((await turn(t, cookie, { secrets: { id: form?.id, values: {} } })).status).toBe(400);
});

test("a turn waits for the one before it", async () => {
  const { promise, resolve } = Promise.withResolvers<void>();
  const model = new FakeModel([
    { content: [text("Hi.")], wait: promise },
    { content: [text("Ok.")] },
  ]);
  const t = await testApp(model);
  const { cookie } = signIn(t);
  const slow = turn(t, cookie, { start: { timezone: "" } });
  await waitFor(() => model.requests.length === 1);
  expect((await turn(t, cookie, { say: "hello?" })).status).toBe(409);
  resolve();
  await slow;
  expect((await turn(t, cookie, { say: "hello" })).status).toBe(200);
});

test("Run setup again starts a new interview with every topic to do, and setup stays finished", async () => {
  const model = new FakeModel([
    { content: [toolUse("topic", { topic: "safety", state: "skipped" })] },
    { content: [text("Next.")] },
  ]);
  const t = await testApp(model);
  const { cookie } = signIn(t);
  await turn(t, cookie, { start: { timezone: "" } });
  await t.call("POST", "/onboarding/finish", undefined, { cookie });
  const again = (await (
    await t.call("POST", "/onboarding/again", undefined, { cookie })
  ).json()) as Onboarding;
  expect(again).toMatchObject({ finished: true, items: [] });
  expect(Object.values(again.topics)).toEqual(Array(6).fill("todo"));
});

test("a provider key that fails isn't saved, and one that works is, with the roles for its models", async () => {
  const t = track(await testApp(undefined, undefined, {}, [anthropicPlugin, openaiPlugin]));
  const { cookie } = signIn(t);
  let works = false;
  t.outside.fetch = async (url) =>
    url.startsWith("https://api.anthropic.com/v1/models")
      ? works
        ? Response.json({ data: [], has_more: false, first_id: null, last_id: null })
        : Response.json(
            {
              type: "error",
              error: { type: "authentication_error", message: "invalid x-api-key" },
            },
            { status: 401 },
          )
      : url === "https://openrouter.ai/api/v1/models"
        ? Response.json({
            data: [
              {
                id: "anthropic/claude-haiku-5.5",
                pricing: { prompt: "0.000001", completion: "0.000005" },
                supported_parameters: ["tools"],
              },
              {
                id: "anthropic/claude-opus-5.5",
                pricing: { prompt: "0.000005", completion: "0.000025" },
                supported_parameters: ["tools"],
              },
              {
                id: "acme/cheap",
                pricing: { prompt: "0.0000001", completion: "0.0000002" },
                supported_parameters: ["tools"],
              },
            ],
          })
        : new Response(null, { status: 404 });

  const bad = await t.call(
    "POST",
    "/onboarding/models",
    { provider: "anthropic", key: "sk-ant-bad" },
    { cookie },
  );
  expect(bad.status).toBe(400);
  expect(await bad.json()).toMatchObject({ field: "key" });
  expect(t.plugins.env().ANTHROPIC_API_KEY).toBeUndefined();

  works = true;
  const ok = await t.call(
    "POST",
    "/onboarding/models",
    { provider: "anthropic", key: "sk-ant-good" },
    { cookie },
  );
  expect(ok.status).toBe(200);
  expect(t.plugins.env().ANTHROPIC_API_KEY).toBe("sk-ant-good");

  const or = await t.call(
    "POST",
    "/onboarding/models",
    { provider: "openai", key: "sk-or-x" },
    { cookie },
  );
  expect(or.status).toBe(200);
  expect(t.plugins.get("openai")?.enabled).toBe(true);
  expect(t.settings.get()).toMatchObject({
    chatModel: "anthropic/claude-haiku-5.5",
    expertModel: "anthropic/claude-opus-5.5",
  });
});
