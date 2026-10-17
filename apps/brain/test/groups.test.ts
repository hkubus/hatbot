import { expect, test } from "bun:test";
import type { Bot, Conversation } from "@hatbot/shared";
import { mentionsIn } from "../src/agent/thread";
import { FakeModel, text } from "./fake-model";
import { setUpOwner, type TestApp, testApp } from "./helpers";

const bot = (t: TestApp, name: string) =>
  t.bots.create({ name, instructions: "", chatModel: null, chatEffort: null, plugins: null });

/** The last turn, and the app's note after it if there is one. */
const lastText = (req: { messages: { content: unknown }[] } | undefined) =>
  JSON.stringify(req?.messages.slice(-2));

async function group(t: TestApp, cookie: string, botIds: string[]) {
  const res = await t.call("POST", "/conversations", { title: "Kitchen", botIds }, { cookie });
  expect(res.status).toBe(201);
  return (await res.json()) as Conversation;
}

test("@name picks who answers, else the last bot to speak, and a bot can bring another in", async () => {
  const model = new FakeModel([
    { content: [text("Soup. @Hatbot, is the pot free?")] },
    { content: [text("It is.")] },
    { content: [text("Then start at six.")] },
    { content: [text("Bread too.")] },
  ]);
  const t = await testApp(model);
  const { cookie } = await setUpOwner(t);
  bot(t, "Chef");
  expect(
    (await t.call("POST", "/conversations", { botIds: ["chef", "nope"] }, { cookie })).status,
  ).toBe(400);
  expect(
    (await t.call("POST", "/conversations", { botIds: ["chef", "chef"] }, { cookie })).status,
  ).toBe(400);
  const g = await group(t, cookie, ["chef", "hatbot"]);
  expect(g).toMatchObject({ kind: "group", title: "Kitchen", botIds: ["chef", "hatbot"] });
  const thread = t.chats.thread(g.id);
  if (!thread) throw new Error("no group");

  // No mention and no one has spoken: the first bot answers, and brings Hatbot in.
  await thread.post("what's for dinner?").done;
  expect(thread.list().map((m) => [m.botId, m.text])).toEqual([
    [null, "what's for dinner?"],
    ["chef", "Soup. @Hatbot, is the pot free?"],
    ["hatbot", "It is."],
  ]);
  const system = JSON.stringify(model.requests[0]?.system);
  expect(system).toContain("is a group chat with the owner and these bots: Chef, Hatbot");
  expect(lastText(model.requests[1])).toContain(
    '<message from=\\"Chef\\" at=\\"Fri 2026-10-09 12:00\\">Soup. @Hatbot',
  );
  expect(lastText(model.requests[1])).toContain(
    `<message from=\\"Owner\\" at=\\"Fri 2026-10-09 12:00\\">what's for dinner?</message>`,
  );
  expect(lastText(model.requests[1])).toContain("you were mentioned");

  // No mention: Hatbot spoke last.
  await thread.post("ok").done;
  // @Chef picks Chef, who hears what came since it last spoke, and not its own words.
  await thread.post("@chef and bread?").done;
  expect(
    thread
      .list()
      .slice(-4)
      .map((m) => m.botId),
  ).toEqual([null, "hatbot", null, "chef"]);
  const chefSaw = JSON.stringify(model.requests[3]?.messages.at(-1));
  expect(chefSaw).toContain(
    '<message from=\\"Hatbot\\" at=\\"Fri 2026-10-09 12:00\\">It is.</message>',
  );
  expect(chefSaw).toContain(
    '<message from=\\"Owner\\" at=\\"Fri 2026-10-09 12:00\\">@chef and bread?</message>',
  );
  expect(chefSaw).not.toContain("Soup.");
  // Each bot keeps its own turns.
  expect(model.requests[3]?.messages.length).toBe(3);

  expect(
    (
      await t.call(
        "POST",
        `/conversations/${g.id}/messages`,
        { text: "hi", incognito: true },
        { cookie },
      )
    ).status,
  ).toBe(400);
});

test("at most 4 bot replies follow one message", async () => {
  const model = new FakeModel(
    Array.from({ length: 6 }, (_, i) => ({
      content: [text(i % 2 ? `@Chef ${i}` : `@Hatbot ${i}`)],
    })),
  );
  const t = await testApp(model);
  const { cookie } = await setUpOwner(t);
  bot(t, "Chef");
  const g = await group(t, cookie, ["chef", "hatbot"]);
  const thread = t.chats.thread(g.id);
  await thread?.post("@Chef go").done;
  expect(thread?.list().filter((m) => m.role === "assistant").length).toBe(4);
  expect(model.requests.length).toBe(4);
});

test("a group's name and bots change, and it can be deleted", async () => {
  const t = await testApp(new FakeModel());
  const { cookie } = await setUpOwner(t);
  bot(t, "Chef");
  bot(t, "Coder");
  const g = await group(t, cookie, ["chef", "hatbot"]);
  const res = await t.call(
    "PATCH",
    `/conversations/${g.id}`,
    { title: "House", botIds: ["chef", "coder", "hatbot"] },
    { cookie },
  );
  expect(await res.json()).toMatchObject({ title: "House", botIds: ["chef", "coder", "hatbot"] });
  expect((await t.call("PATCH", "/conversations/1", { title: "x" }, { cookie })).status).toBe(404);
  expect((await t.call("DELETE", "/conversations/1", undefined, { cookie })).status).toBe(404);
  expect((await t.call("DELETE", `/conversations/${g.id}`, undefined, { cookie })).status).toBe(
    200,
  );
  const chats = (await (
    await t.call("GET", "/conversations", undefined, { cookie })
  ).json()) as Conversation[];
  expect(chats.every((c) => c.kind === "direct")).toBe(true);
  expect(t.chats.thread(g.id)).toBeNull();
});

test("mentions are found by name or id, in order", () => {
  const b = (id: string, name: string): Bot => ({
    id,
    name,
    icon: "hat",
    color: "amber",
    instructions: "",
    chatModel: null,
    chatEffort: null,
    plugins: null,
    createdAt: "",
  });
  const bots = [b("hatbot", "Hatbot"), b("home-lab", "Home Lab"), b("chef", "Chef")];
  expect(mentionsIn("@home lab then @CHEF", bots).map((x) => x.id)).toEqual(["home-lab", "chef"]);
  expect(mentionsIn("mail me@chef.com or @chefs", bots)).toEqual([]);
  expect(mentionsIn("ask @hatbot.", bots).map((x) => x.id)).toEqual(["hatbot"]);
});
