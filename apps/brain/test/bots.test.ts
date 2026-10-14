import { expect, test } from "bun:test";
import type { Bot, Conversation, Task, ThreadMessage } from "@hatbot/shared";
import { slugOf } from "../src/bots";
import { FakeModel, text, toolUse } from "./fake-model";
import { setUpOwner, type TestApp, testApp } from "./helpers";

const systemOf = (req: { system?: unknown } | undefined) => JSON.stringify(req?.system);

test("Hatbot is the first bot, and /thread is its chat", async () => {
  const t = await testApp(new FakeModel([{ content: [text("Hi.")] }]));
  const { cookie } = await setUpOwner(t);
  const bots = (await (await t.call("GET", "/bots", undefined, { cookie })).json()) as Bot[];
  expect(bots.map((b) => [b.id, b.name])).toEqual([["hatbot", "Hatbot"]]);

  await t.thread.post("hello").done;
  const chats = (await (
    await t.call("GET", "/conversations", undefined, { cookie })
  ).json()) as Conversation[];
  expect(chats).toMatchObject([{ id: 1, kind: "direct", botIds: ["hatbot"], unread: 1 }]);
  const msgs = (await (
    await t.call("GET", "/conversations/1/messages", undefined, { cookie })
  ).json()) as ThreadMessage[];
  expect(msgs.map((m) => [m.role, m.botId, m.conversationId])).toEqual([
    ["user", null, 1],
    ["assistant", "hatbot", 1],
  ]);
  // On its own, Hatbot's prompt is as it was: no roster to break the cache.
  expect(systemOf(t.model.requests[0])).not.toContain("other bots");
  expect((await t.call("DELETE", "/bots/hatbot", undefined, { cookie })).status).toBe(400);
});

test("a new bot has its own chat, name, role and memory folder", async () => {
  const model = new FakeModel([
    {
      content: [
        toolUse("memory_write", { path: "bots/hatbot-2/x.md", content: "no", reason: "try" }),
        toolUse("memory_write", {
          path: "bots/chef/recipes.md",
          content: "# Soup",
          reason: "keep",
        }),
      ],
    },
    { content: [text("Saved the soup.")] },
    { content: [text("Hi from Hatbot.")] },
  ]);
  const t = await testApp(model);
  const { cookie } = await setUpOwner(t);
  const res = await t.call(
    "POST",
    "/bots",
    { name: "Chef", instructions: "You plan the week's meals." },
    { cookie },
  );
  expect(res.status).toBe(201);
  const chef = (await res.json()) as Bot;
  expect(chef.id).toBe("chef");
  expect((await t.call("POST", "/bots", { name: "chef" }, { cookie })).status).toBe(400);

  const chats = (await (
    await t.call("GET", "/conversations", undefined, { cookie })
  ).json()) as Conversation[];
  await t.memory.write(
    "bots/chef/INDEX.md",
    "# Chef's notes",
    { name: "Chef", email: "chef@hatbot.local" },
    "start",
  );
  const chefChat = chats.find((c) => c.botIds[0] === "chef");
  if (!chefChat) throw new Error("no chat for Chef");
  expect(
    (
      await t.call(
        "POST",
        `/conversations/${chefChat.id}/messages`,
        { text: "save a soup" },
        { cookie },
      )
    ).status,
  ).toBe(202);
  await t.chats.idle();

  const system = systemOf(model.requests[0]);
  expect(system).toContain("You are Chef");
  expect(system).toContain("You plan the week's meals.");
  expect(system).toContain("Hatbot (hatbot)");
  const first = model.requests[0]?.messages[0]?.content as { text: string }[];
  expect(first[0]?.text).toContain('<your_memory_index path="bots/chef/INDEX.md">');
  // Its own folder only.
  const results = JSON.stringify(model.requests[1]?.messages.at(-1));
  expect(results).toContain("own memory folder; leave it to them");
  expect(await t.memory.read("bots/chef/recipes.md")).toBe("# Soup\n");
  const log = await t.memory.log(1, "bots/chef/recipes.md");
  expect(log[0]?.author).toBe("Chef");

  const msgs = t.chats.thread(chefChat.id)?.list() ?? [];
  expect(msgs.at(-1)).toMatchObject({ botId: "chef", text: "Saved the soup." });
  // Hatbot's chat is untouched, and its prompt now names Chef.
  expect(t.thread.list()).toEqual([]);
  await t.thread.post("hi").done;
  expect(systemOf(model.requests[2])).toContain("Chef (chef): You plan the week's meals.");
});

test("a bot's tasks report in its chat, and deleting it hands its schedules to Hatbot", async () => {
  const work = new FakeModel([
    { content: [toolUse("finish_task", { outcome: "done", summary: "Menu set.", notify: true })] },
  ]);
  const t = await testApp(new FakeModel(), work);
  const { cookie } = await setUpOwner(t);
  const chef = t.bots.create({
    name: "Chef",
    instructions: "",
    chatModel: null,
    chatEffort: null,
    plugins: null,
  });
  const res = await t.call(
    "POST",
    "/schedules",
    { name: "Menu", prompt: "Plan the menu", cron: "0 8 * * 1", botId: chef.id },
    { cookie },
  );
  const schedule = (await res.json()) as { id: number; botId: string };
  expect(schedule.botId).toBe("chef");
  expect(
    (
      await t.call(
        "POST",
        "/schedules",
        { name: "X", prompt: "x", cron: "0 8 * * 1", botId: "nope" },
        { cookie },
      )
    ).status,
  ).toBe(400);

  const task = t.schedules.runNow(schedule.id);
  if (!task) throw new Error("no task");
  expect(task.botId).toBe("chef");
  await t.tasks.idle();
  expect(t.tasks.get(task.id)?.summary).toBe("Menu set.");
  // Its prompt is Chef's.
  expect(systemOf(work.requests[0])).toContain("Chef");
  const chefChat = t.chats.direct("chef");
  expect(chefChat.list().map((m) => [m.kind, m.botId])).toEqual([["task", "chef"]]);
  expect(t.thread.list()).toEqual([]);

  expect((await t.call("DELETE", "/bots/chef", undefined, { cookie })).status).toBe(200);
  expect(t.schedules.get(schedule.id)?.botId).toBe("hatbot");
  const chats = (await (
    await t.call("GET", "/conversations", undefined, { cookie })
  ).json()) as Conversation[];
  expect(chats.map((c) => c.botIds)).toEqual([["hatbot"]]);
});

test("a bot has an icon and a colour, a new one in a colour no other bot has", async () => {
  const t = await testApp(new FakeModel());
  const { cookie } = await setUpOwner(t);
  const post = async (body: object) =>
    (await (await t.call("POST", "/bots", body, { cookie })).json()) as Bot;
  expect(t.bots.hatbot()).toMatchObject({ icon: "hat", color: "amber" });
  expect(await post({ name: "Chef" })).toMatchObject({ icon: "hat", color: "red" });
  expect(await post({ name: "Coder", icon: "code", color: "blue" })).toMatchObject({
    icon: "code",
    color: "blue",
  });
  expect((await post({ name: "Gardener" })).color).toBe("pink");
  expect((await t.call("POST", "/bots", { name: "X", icon: "nope" }, { cookie })).status).toBe(400);

  const res = await t.call("PATCH", "/bots/hatbot", { icon: "cat", color: "teal" }, { cookie });
  expect(await res.json()).toMatchObject({ name: "Hatbot", icon: "cat", color: "teal" });
  expect(t.bots.hatbot()).toMatchObject({ icon: "cat", color: "teal" });
});

test("a bot's id comes from its name", () => {
  expect(slugOf("Home Lab")).toBe("home-lab");
  expect(slugOf("Café")).toBe("cafe");
  expect(slugOf("42")).toBe("bot-42");
});

const chef = (t: TestApp) =>
  t.bots.create({
    name: "Chef",
    instructions: "Plans meals.",
    chatModel: null,
    chatEffort: null,
    plugins: null,
  });

test("from the chat, ask_bot starts the other bot's task, and the asker reports", async () => {
  const model = new FakeModel([
    { content: [toolUse("ask_bot", { bot: "chef", request: "Plan Sunday dinner" })] },
    { content: [text("Asked Chef.")] },
    { content: [text("Chef says: soup.")] },
  ]);
  const work = new FakeModel([
    { content: [toolUse("finish_task", { outcome: "done", summary: "Soup.", notify: false })] },
  ]);
  const t = await testApp(model, work);
  await setUpOwner(t);
  chef(t);
  await t.thread.post("what's for Sunday? ask Chef").done;
  const task = t.tasks.list({}).find((x) => x.botId === "chef");
  if (!task) throw new Error("no task");
  expect(task).toMatchObject({
    requestedBy: "hatbot",
    parentId: null,
    title: "Plan Sunday dinner",
  });
  // Under Hatbot's reply, in Hatbot's chat.
  expect(t.thread.list().find((m) => m.taskId === task.id)?.botId).toBe("hatbot");
  await t.tasks.idle();
  await t.chats.idle();
  expect(JSON.stringify(work.requests[0]?.messages)).toContain("Asked by Hatbot");
  expect(systemOf(work.requests[0])).toContain("You are Chef");
  // Hatbot hears how it ended and tells you.
  expect(JSON.stringify(model.requests[2]?.messages.at(-1))).toContain("by Chef, which you asked");
  expect(t.thread.list().at(-1)?.text).toBe("Chef says: soup.");
  expect(t.chats.direct("chef").list()).toEqual([]);
});

test("from a task, ask_bot waits for the other bot, and taint goes both ways", async () => {
  const work = new FakeModel([
    { content: [toolUse("ask_bot", { bot: "Chef", request: "Plan Sunday dinner" })] },
    { content: [toolUse("finish_task", { outcome: "done", summary: "Soup.", notify: false })] },
    {
      content: [toolUse("finish_task", { outcome: "done", summary: "Chef: soup.", notify: false })],
    },
  ]);
  const t = await testApp(new FakeModel(), work);
  chef(t);
  const parent = t.tasks.createBackgroundTask({
    title: "Weekend",
    goal: "Plan the weekend",
    origin: "webhook",
    source: "hook",
    payload: "{}",
  });
  if (!parent) throw new Error("no task");
  await t.tasks.idle();
  const child = t.tasks.list({}).find((x) => x.botId === "chef");
  expect(child).toMatchObject({ parentId: parent.id, requestedBy: "hatbot", tainted: true });
  expect(JSON.stringify(work.requests[2]?.messages.at(-1))).toContain('<summary from=\\"Chef\\">');
  expect(t.tasks.get(parent.id)?.summary).toBe("Chef: soup.");
});

test("hand-offs nest at most 3 deep, and a bot can't ask itself", async () => {
  const t = await testApp(new FakeModel(), new FakeModel());
  const c = chef(t);
  const hatbot = t.bots.hatbot();
  let parent: Task | undefined;
  for (let i = 0; i < 3; i++) {
    const next = t.tasks.askBot({
      from: i % 2 ? c : hatbot,
      to: i % 2 ? "hatbot" : "chef",
      request: `step ${i}`,
      parent,
      taintedBy: null,
    });
    if (typeof next === "string") throw new Error(next);
    parent = next;
  }
  expect(t.tasks.handoffs(parent ?? null)).toBe(3);
  expect(
    t.tasks.askBot({ from: c, to: "hatbot", request: "more", parent, taintedBy: null }),
  ).toContain("at most 3 deep");
  expect(t.tasks.askBot({ from: c, to: "Chef", request: "x", taintedBy: null })).toContain(
    "That's you",
  );
  await t.tasks.idle();
});

test("alone, Hatbot isn't offered ask_bot", async () => {
  const t = await testApp(new FakeModel([{ content: [text("Hi.")] }]));
  await setUpOwner(t);
  await t.thread.post("hi").done;
  const names = t.model.requests[0]?.tools?.map((x) => ("name" in x ? x.name : ""));
  expect(names).not.toContain("ask_bot");
});

test("a desktop task opens its bot's browser profile", async () => {
  const work = new FakeModel([
    { content: [toolUse("finish_task", { outcome: "done", summary: "Looked.", notify: false })] },
    { content: [toolUse("finish_task", { outcome: "done", summary: "Looked.", notify: false })] },
  ]);
  const t = await testApp(new FakeModel(), work);
  chef(t);
  for (const botId of ["chef", "hatbot"]) {
    t.tasks.createDesktopTask({
      title: "Look",
      goal: "Look",
      successCriteria: "",
      origin: "chat",
      botId,
    });
    await t.tasks.idle();
  }
  expect(t.agent.profiles).toEqual(["chef", "hatbot"]);
});
