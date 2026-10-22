import { expect, test } from "bun:test";
import type { Bot, Conversation } from "@hatbot/shared";
import { mentionsIn } from "../src/agent/thread";
import { FakeModel, text } from "./fake-model";
import { bot, signIn, type TestApp, testApp } from "./helpers";

async function group(t: TestApp, cookie: string, botIds: string[]) {
  const res = await t.call("POST", "/conversations", { title: "Kitchen", botIds }, { cookie });
  expect(res.status).toBe(201);
  return (await res.json()) as Conversation;
}

test("in a group, @name picks who answers, else the last bot to speak, and a bot can bring another in; it can change and be deleted", async () => {
  const model = new FakeModel([
    { content: [text("Soup. @Hatbot, is the pot free?")] },
    { content: [text("It is.")] },
    { content: [text("Then start at six.")] },
    { content: [text("Bread too.")] },
  ]);
  const t = await testApp(model);
  const { cookie } = signIn(t);
  bot(t, "Chef");
  bot(t, "Coder");
  for (const botIds of [
    ["chef", "nope"],
    ["chef", "chef"],
  ])
    expect((await t.call("POST", "/conversations", { botIds }, { cookie })).status).toBe(400);
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
  const hatbotSaw = JSON.stringify(model.requests[1]?.messages.slice(-2));
  expect(hatbotSaw).toContain(
    `<message from=\\"Owner\\" at=\\"Fri 2026-10-09 12:00\\">what's for dinner?</message>`,
  );
  expect(hatbotSaw).toContain('<message from=\\"Chef\\" at=\\"Fri 2026-10-09 12:00\\">Soup.');

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
  expect(chefSaw).not.toContain("Soup.");
  expect(model.requests[3]?.messages.length).toBe(3);
  const b = (id: string, name: string) => ({ id, name }) as Bot;
  const bots = [b("hatbot", "Hatbot"), b("home-lab", "Home Lab"), b("chef", "Chef")];
  expect(mentionsIn("@home lab then @CHEF", bots).map((x) => x.id)).toEqual(["home-lab", "chef"]);
  expect(mentionsIn("mail me@chef.com or @chefs", bots)).toEqual([]);
  expect(mentionsIn("ask @hatbot.", bots).map((x) => x.id)).toEqual(["hatbot"]);

  const secret = { text: "hi", incognito: true };
  expect((await t.call("POST", `/conversations/${g.id}/messages`, secret, { cookie })).status).toBe(
    400,
  );

  // Its name and bots change, and it can be deleted; a bot's own chat can't.
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
  expect(t.chats.thread(g.id)).toBeNull();
});

test("at most 4 bot replies follow one message", async () => {
  const model = new FakeModel(
    Array.from({ length: 6 }, (_, i) => ({
      content: [text(i % 2 ? `@Chef ${i}` : `@Hatbot ${i}`)],
    })),
  );
  const t = await testApp(model);
  const { cookie } = signIn(t);
  bot(t, "Chef");
  const g = await group(t, cookie, ["chef", "hatbot"]);
  const thread = t.chats.thread(g.id);
  await thread?.post("@Chef go").done;
  expect(thread?.list().filter((m) => m.role === "assistant").length).toBe(4);
  expect(model.requests.length).toBe(4);
});
