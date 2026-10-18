import { expect, test } from "bun:test";
import type { Bot, Conversation, Task } from "@hatbot/shared";
import { FakeModel, text, toolUse } from "./fake-model";
import { signIn, type TestApp, testApp, waitFor } from "./helpers";

const systemOf = (req: { system?: unknown } | undefined) => JSON.stringify(req?.system);

const bot = (t: TestApp, name: string, instructions = "") =>
  t.bots.create({ name, instructions, chatModel: null, chatEffort: null, plugins: null });

const finish = (summary: string) => ({
  content: [toolUse("finish_task", { outcome: "done", summary, notify: true })],
});

test("a bot has its own id, chat and memory folder, and its tasks run as it", async () => {
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
  ]);
  const work = new FakeModel([finish("Menu set."), finish("Looked.")]);
  const t = await testApp(model, work);
  const { cookie } = signIn(t);
  const post = (body: object) => t.call("POST", "/bots", body, { cookie });
  const res = await post({ name: "Chef", instructions: "You plan the week's meals." });
  expect(res.status).toBe(201);
  expect(((await res.json()) as Bot).id).toBe("chef");
  expect((await post({ name: "chef" })).status).toBe(400);
  // Polish letters become plain ones.
  expect(((await (await post({ name: "Łowca okazji" })).json()) as Bot).id).toBe("lowca-okazji");
  expect((await t.call("DELETE", "/bots/hatbot", undefined, { cookie })).status).toBe(400);

  const chef = t.chats.direct("chef");
  const sent = await t.call(
    "POST",
    `/conversations/${chef.conversationId}/messages`,
    { text: "save a soup" },
    { cookie },
  );
  expect(sent.status).toBe(202);
  await t.chats.idle();
  expect(systemOf(model.requests[0])).toContain("You plan the week's meals.");
  // Its own folder only.
  expect(await t.memory.exists("bots/hatbot-2/x.md")).toBe(false);
  expect(await t.memory.read("bots/chef/recipes.md")).toBe("# Soup\n");
  expect((await t.memory.log(1, "bots/chef/recipes.md"))[0]?.author).toBe("Chef");
  expect(chef.list().at(-1)).toMatchObject({ botId: "chef", text: "Saved the soup." });
  expect(t.thread.list()).toEqual([]);

  // A schedule for it runs as it and reports in its chat; a desktop task opens its browser profile.
  const schedule = async (botId: string) =>
    t.call(
      "POST",
      "/schedules",
      { name: "Menu", prompt: "Plan the menu", cron: "0 8 * * 1", botId },
      { cookie },
    );
  expect((await schedule("nope")).status).toBe(400);
  const { id } = (await (await schedule("chef")).json()) as { id: number };
  const task = t.schedules.runNow(id);
  expect(task?.botId).toBe("chef");
  await t.tasks.idle();
  expect(systemOf(work.requests[0])).toContain("You plan the week's meals.");
  expect(chef.list().at(-1)).toMatchObject({ kind: "task", botId: "chef", taskId: task?.id });
  expect(t.thread.list()).toEqual([]);
  t.tasks.createDesktopTask({
    title: "Look",
    goal: "Look",
    successCriteria: "",
    origin: "chat",
    botId: "chef",
  });
  await t.tasks.idle();
  expect(t.agent.profiles).toEqual(["chef"]);
});

test("a deleted bot's chat takes no new messages, and what it left goes to Hatbot switched off, in the making too", async () => {
  let go = () => {};
  const chat = new FakeModel([
    {
      content: [toolUse("schedule_create", { name: "Nightly", prompt: "Cook", cron: "0 3 * * *" })],
      wait: new Promise<void>((r) => {
        go = r;
      }),
    },
    { content: [text("Made it.")] },
  ]);
  const t = await testApp(chat);
  const { cookie } = signIn(t);
  bot(t, "Chef");
  const s = t.schedules.create(
    { name: "Menu", prompt: "Plan", cron: "0 8 * * 1", botId: "chef" },
    "owner",
  );
  t.agent.pages.set("https://menu.example/", "soup");
  const watch = {
    name: "Menu",
    source: { kind: "page" as const, url: "https://menu.example/" },
    condition: { when: "changed" as const },
    prompt: "Cook it",
    everyMinutes: 60,
    once: false,
    enabled: true,
    botId: "chef",
  };
  const w = await t.watchers.create(watch, "owner");
  const trigger = t.triggers.create({
    name: "Pantry",
    kind: "webhook",
    prompt: "x",
    botId: "chef",
  });
  t.settings.update({ heartbeat: { ...t.settings.get().heartbeat, enabled: true, botId: "chef" } });
  // Its reply is still making a schedule when it's deleted.
  const chef = t.chats.direct("chef");
  const reply = chef.post("make a nightly schedule");
  await waitFor(() => chat.requests.length === 1);
  const before = t.events.length;
  expect((await t.call("DELETE", "/bots/chef", undefined, { cookie })).status).toBe(200);
  go();
  await reply.done;
  expect(t.schedules.list().map((x) => x.id)).toEqual([s.id]);
  // Hatbot may have plugins Chef didn't: they move over switched off, for you to look over.
  expect(t.schedules.get(s.id)).toMatchObject({ botId: "hatbot", enabled: false, nextRunAt: null });
  expect(t.watchers.get(w.id)).toMatchObject({ botId: "hatbot", enabled: false });
  expect(t.triggers.get(trigger.id)).toMatchObject({ botId: "hatbot", enabled: false });
  expect(t.settings.get().heartbeat).toMatchObject({ enabled: false, botId: "hatbot" });
  expect(t.events.slice(before).map((e) => e.type)).toEqual(
    expect.arrayContaining(["schedule.updated", "watcher.updated", "trigger.updated"]),
  );
  expect(t.schedules.update(s.id, { enabled: true })?.nextRunAt).not.toBeNull();

  // A page or phone still showing its chat can't start it again, nor have Hatbot answer there.
  const asked = chat.requests.length;
  const url = `/conversations/${chef.conversationId}`;
  for (const [path, body] of [
    ["/messages", { text: "still there?" }],
    ["/ask", { text: "still there?" }],
    [`/messages/${chef.list().at(-1)?.id}/retry`, undefined],
  ] as const)
    expect((await t.call("POST", `${url}${path}`, body, { cookie })).status).toBe(410);
  await t.chats.idle();
  expect(chat.requests.length).toBe(asked);
  const chats = (await (
    await t.call("GET", "/conversations", undefined, { cookie })
  ).json()) as Conversation[];
  expect(chats.map((c) => c.botIds)).toEqual([["hatbot"]]);

  // A reply that goes on after its bot is gone doesn't make one either.
  let next = () => {};
  chat.script.push(
    {
      content: [
        toolUse("schedule_create", { name: "Nightly", prompt: "Do it", cron: "0 3 * * *" }),
      ],
      wait: new Promise<void>((r) => {
        next = r;
      }),
    },
    { content: [text("Made it.")] },
  );
  bot(t, "Ops");
  const again = t.chats.direct("ops").post("make a nightly schedule");
  await waitFor(() => chat.requests.length === asked + 1);
  t.bots.delete("ops");
  next();
  await again.done;
  expect(t.schedules.list()).toHaveLength(1);

  // Ones made as it was deleted, that the move missed, are moved switched off when they come due.
  bot(t, "Cook");
  const s2 = t.schedules.create(
    { name: "Menu", prompt: "Plan", cron: "0 8 * * 1", botId: "cook" },
    "owner",
  );
  const w2 = await t.watchers.create({ ...watch, botId: "cook" }, "owner");
  const t2 = t.triggers.create({ name: "Pantry", kind: "webhook", prompt: "x", botId: "cook" });
  t.db.query("UPDATE bots SET deleted_at = '2026-10-09T12:00:00Z' WHERE id = 'cook'").run();
  expect(t.schedules.runNow(s2.id)).toBeNull();
  expect(t.schedules.get(s2.id)).toMatchObject({ botId: "hatbot", enabled: false });
  expect(t.triggers.receiveWebhook(t2.id, "{}", false)).toEqual({
    status: "skipped",
    reason: "disabled",
  });
  expect(t.triggers.get(t2.id)).toMatchObject({ botId: "hatbot", enabled: false });
  t.agent.pages.set("https://menu.example/", "stew");
  await t.watchers.checkNow(w2.id);
  expect(t.watchers.get(w2.id)).toMatchObject({ botId: "hatbot", enabled: false });
  expect(t.tasks.list()).toEqual([]);
  // So is a heartbeat whose bot went that way.
  t.settings.update({ heartbeat: { ...t.settings.get().heartbeat, enabled: true, botId: "cook" } });
  await t.heartbeat.run();
  expect(t.settings.get().heartbeat).toMatchObject({ enabled: false, botId: "hatbot" });
});

test("a task can ask another bot and waits for it; taint goes both ways, and hand-offs nest 3 deep at most", async () => {
  const work = new FakeModel([
    { content: [toolUse("ask_bot", { bot: "Chef", request: "Plan Sunday dinner" })] },
    { content: [toolUse("finish_task", { outcome: "done", summary: "Soup.", notify: false })] },
    {
      content: [toolUse("finish_task", { outcome: "done", summary: "Chef: soup.", notify: false })],
    },
  ]);
  const t = await testApp(new FakeModel(), work);
  const c = bot(t, "Chef", "Plans meals.");
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
  expect(JSON.stringify(work.requests[2]?.messages.at(-1))).toContain(
    '<summary from=\\"Chef\\" trusted=\\"false\\">',
  );
  expect(t.tasks.get(parent.id)?.summary).toBe("Chef: soup.");

  work.script.push(finish("1"), finish("2"), finish("3"));
  const hatbot = t.bots.hatbot();
  let up: Task | undefined;
  for (let i = 0; i < 3; i++) {
    const next = t.tasks.askBot({
      from: i % 2 ? c : hatbot,
      to: i % 2 ? "hatbot" : "chef",
      request: `step ${i}`,
      parent: up,
      taintedBy: null,
    });
    if (typeof next === "string") throw new Error(next);
    up = next;
  }
  expect(
    typeof t.tasks.askBot({ from: c, to: "hatbot", request: "more", parent: up, taintedBy: null }),
  ).toBe("string");
  expect(typeof t.tasks.askBot({ from: c, to: "Chef", request: "x", taintedBy: null })).toBe(
    "string",
  );
  await t.tasks.idle();
});
