// Changing plugins from the chat and tasks, as Settings → Safety's "Changing plugins" says.
import { expect, test } from "bun:test";
import { homeassistantPlugin } from "@hatbot/plugin-homeassistant";
import { definePlugin, type ModelProvider, ready } from "@hatbot/plugin-sdk";
import { z } from "zod";
import { FakeModel, isReview, text, toolUse } from "./fake-model";
import { type TestApp, testApp, waitFor } from "./helpers";
import { stopPluginsAfterEach, track } from "./plugin-helpers";

stopPluginsAfterEach();

const garden = definePlugin({
  id: "garden",
  name: "Garden",
  description: "Waters the garden",
  env: [
    { name: "GARDEN_URL", hint: "http://garden.lan" },
    { name: "GARDEN_TOKEN", secret: true },
  ],
  config: z.object({ minutes: z.number().int().min(1).max(60).default(10) }),
  start: () => ready([]),
});

/** Serves the models Hatbot runs on, as the settings name them. */
const provider = (ids: string[]) => {
  const models: ModelProvider = {
    models: () => ids.map((id) => ({ id, name: id, capabilities: {} })),
    stream: async () => {
      throw new Error("not here");
    },
    create: async () => {
      throw new Error("not here");
    },
  };
  return definePlugin({
    id: "llm",
    name: "LLM",
    description: "",
    config: z.object({ region: z.string().default("eu") }),
    defaultOn: true,
    start: () => ready([], { models }),
  });
};

const say = (t: string) => ({ content: [text(t)] });
const calls = (name: string, input: object) => ({ content: [toolUse(name, input)] });
const finish = calls("finish_task", { outcome: "done", summary: "Done.", notify: false });

async function app(chat = new FakeModel(), work = new FakeModel()) {
  const t = track(
    await testApp(chat, work, {}, [garden, homeassistantPlugin, provider([])], {
      GARDEN_TOKEN: "garden-token-on-the-host",
    }),
  );
  await t.plugins.startAll();
  return t;
}

/** One chat reply that makes `name`'s call, then says it's done. */
async function chatCall(t: TestApp, chat: FakeModel, name: string, input: object) {
  chat.script.push(calls(name, input), say("Done."));
  await t.thread.post("please").done;
}

/** The approval that call raises, denied so the reply ends. */
async function asked(t: TestApp, chat: FakeModel, name: string, input: object) {
  chat.script.push(calls(name, input), say("Ok."));
  const reply = t.thread.post("please").done;
  const a = await waitFor(() => t.approvals.list(true)[0]);
  t.approvals.decide(a.id, "deny", "web");
  await reply;
  return a;
}

test("the owner asks in the chat to turn a plugin on and set its address: it asks first, and once approved it's on and set", async () => {
  const chat = new FakeModel([
    calls("plugins_change", {
      id: "homeassistant",
      on: true,
      values: { HOMEASSISTANT_URL: "http://ha.lan:8123" },
    }),
    say("It's on."),
  ]);
  const t = await app(chat);
  const reply = t.thread.post("Turn on Home Assistant; it's at http://ha.lan:8123").done;
  const asked = await waitFor(() => t.approvals.list(true)[0]);
  expect(asked.kind).toBe("plugins");
  expect(asked.summary).toContain("http://ha.lan:8123");
  expect(t.plugins.get("homeassistant")?.enabled).toBe(false);

  t.approvals.decide(asked.id, "approve", "web");
  await reply;
  expect(t.plugins.get("homeassistant")?.enabled).toBe(true);
  expect(t.plugins.env().HOMEASSISTANT_URL).toBe("http://ha.lan:8123");
});

test("a secret's value is never set through a bot, nor read back to it", async () => {
  const chat = new FakeModel();
  const t = await app(chat);
  await chatCall(t, chat, "plugins_change", {
    id: "garden",
    values: { GARDEN_TOKEN: "from-the-model" },
  });
  expect(t.approvals.list(true)).toEqual([]);
  expect(t.plugins.env().GARDEN_TOKEN).toBe("garden-token-on-the-host");

  await chatCall(t, chat, "plugins_settings", { id: "garden" });
  expect(JSON.stringify(chat.requests)).not.toContain("garden-token-on-the-host");
});

test("a plugin that isn't installed isn't installed by a bot", async () => {
  const chat = new FakeModel();
  const t = await app(chat);
  await chatCall(t, chat, "plugins_change", { id: "weather", on: true });
  expect(t.approvals.list(true)).toEqual([]);
  expect(t.plugins.get("weather")).toBeNull();
});

test("Hatbot's own parts, and the provider of the models in use, can't be turned off or changed by a bot", async () => {
  const chat = new FakeModel();
  const t = await app(chat);
  await chatCall(t, chat, "plugins_change", { id: "secrets", on: false });
  expect(t.plugins.tools().some((x) => x.name === "secrets_list")).toBe(true);

  const served = track(await testApp(chat, new FakeModel(), {}, [provider(["llm-expert"])]));
  await served.plugins.startAll();
  served.settings.update({ expertModel: "llm-expert" });
  await chatCall(served, chat, "plugins_change", { id: "llm", on: false });
  await chatCall(served, chat, "plugins_change", { id: "llm", config: { region: "us" } });
  expect(served.approvals.list(true)).toEqual([]);
  expect(served.plugins.get("llm")).toMatchObject({ enabled: true, config: { region: "eu" } });

  // One that serves none of them is like any other plugin.
  expect((await asked(t, chat, "plugins_change", { id: "llm", on: false })).kind).toBe("plugins");
});

test("settings the plugin's schema refuses aren't saved, and nothing is asked", async () => {
  const chat = new FakeModel();
  const t = await app(chat);
  await chatCall(t, chat, "plugins_change", { id: "garden", config: { minutes: 0 } });
  expect(t.approvals.list(true)).toEqual([]);
  expect(t.plugins.get("garden")?.config).toEqual({ minutes: 10 });
});

test("a mark that keeps something safe is the owner's to take off", async () => {
  const chat = new FakeModel();
  const t = await app(chat);
  await t.plugins.update("homeassistant", { config: { access: ["switch.gate"] } });
  await chatCall(t, chat, "plugins_change", { id: "homeassistant", config: { access: [] } });
  expect(t.approvals.list(true)).toEqual([]);
  expect(t.plugins.get("homeassistant")?.config).toEqual({ access: ["switch.gate"] });

  // Adding one is fine.
  const adding = await asked(t, chat, "plugins_change", {
    id: "homeassistant",
    config: { access: ["switch.gate", "switch.garage"] },
  });
  expect(adding.kind).toBe("plugins");
});

test("Changing plugins set to go ahead runs at once; set to review, the review decides", async () => {
  const work = new FakeModel([
    calls("plugins_change", { id: "garden", on: true }),
    finish,
    calls("plugins_change", { id: "garden", config: { minutes: 5 } }),
    finish,
  ]);
  const reviews: string[] = [];
  work.onCreate = (p) => {
    if (!isReview(p)) return undefined;
    reviews.push(JSON.stringify(p));
    return '{"safe": true, "why": "The owner asked for it."}';
  };
  const t = await app(new FakeModel(), work);
  const run = async () => {
    const id = t.tasks.createBackgroundTask({
      title: "Garden",
      goal: "Set up the garden",
      origin: "chat",
    })?.id;
    await waitFor(() => t.tasks.get(id ?? 0)?.finishedAt);
  };

  t.settings.update({ safety: { kinds: { plugins: "allow" } } });
  await run();
  expect(t.plugins.get("garden")?.enabled).toBe(true);
  expect(reviews).toEqual([]);

  t.settings.update({ safety: { kinds: { plugins: "review" } } });
  await run();
  expect(t.plugins.get("garden")?.config).toEqual({ minutes: 5 });
  expect(reviews).toHaveLength(1);
  expect(t.approvals.list(true)).toEqual([]);
});

test("a bot is given plugins once approved, and never one that isn't installed", async () => {
  const chat = new FakeModel();
  const t = await app(chat);
  const bot = t.bots.create({
    name: "Gardener",
    instructions: "",
    chatModel: null,
    chatEffort: null,
    plugins: [],
  });
  await chatCall(t, chat, "plugins_for_bot", { bot: bot.id, plugins: ["weather"] });
  expect(t.approvals.list(true)).toEqual([]);

  chat.script.push(calls("plugins_for_bot", { bot: bot.id, plugins: ["garden"] }), say("Done."));
  const reply = t.thread.post("Give the gardener the garden").done;
  const asked = await waitFor(() => t.approvals.list(true)[0]);
  expect(asked.kind).toBe("plugins");
  t.approvals.decide(asked.id, "approve", "web");
  await reply;
  expect(t.bots.get(bot.id)?.plugins).toEqual(["garden"]);
});
