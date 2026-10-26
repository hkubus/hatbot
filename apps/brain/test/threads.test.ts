import { expect, test } from "bun:test";
import { type Conversation, MAX_OPEN_THREADS, type Task } from "@hatbot/shared";
import { FakeModel, text, toolUse } from "./fake-model";
import { lastUserText, requested, signIn, testApp, toolNames, waitFor } from "./helpers";
import { ended, finish, scheduled } from "./plugin-helpers";

test("a bot opens a thread from its chat, answers in it while the chat replies, resolves it, and writing opens it again", async () => {
  const { promise: slow, resolve: release } = Promise.withResolvers<void>();
  const model = new FakeModel([
    {
      content: [
        toolUse("thread_open", {
          title: "Backups failing",
          message: "Two guests' backups failed last night. Retry them?",
        }),
      ],
    },
    { content: [text("I opened a thread about the backups.")] },
    { content: [text("Here's the long answer.")], wait: slow },
    { content: [toolUse("thread_resolve", { outcome: "Retried both; they passed" })] },
    { content: [text("Retried, and both passed.")] },
    { content: [text("Noted.")] },
    { content: [text("Hello again.")] },
  ]);
  const t = await testApp(model);
  const { cookie } = signIn(t);
  await t.thread.post("how are the backups?").done;
  expect(toolNames(model.requests[0])).toContain("thread_open");
  expect(toolNames(model.requests[0])).not.toContain("thread_resolve");

  // The thread stays out of the chat list; its card in the chat links to its first message.
  const chats = (await (
    await t.call("GET", "/conversations", undefined, { cookie })
  ).json()) as Conversation[];
  expect(chats.map((c) => c.kind)).toEqual(["direct"]);
  const [thread] = (await (
    await t.call("GET", "/conversations/1/threads", undefined, { cookie })
  ).json()) as Conversation[];
  expect(thread).toMatchObject({ kind: "thread", parentId: 1, title: "Backups failing" });
  const id = thread?.id as number;
  const side = t.chats.thread(id);
  if (!side) throw new Error("no thread");
  const [opener] = side.list();
  expect(opener).toMatchObject({ role: "assistant", botId: "hatbot" });
  expect(t.thread.list().find((m) => m.kind === "thread")).toMatchObject({
    text: "Backups failing",
    link: { conversationId: id, messageId: opener?.id },
  });

  // The chat is busy with a slow reply; the thread answers meanwhile.
  const busy = t.thread.post("tell me something long").done;
  await requested(model, 3);
  await side.post("yes, retry them").done;
  expect(side.list().at(-1)?.text).toBe("Retried, and both passed.");
  const inThread = model.requests[3];
  expect(lastUserText(inThread)).toContain('<thread title=\\"Backups failing\\">');
  expect(lastUserText(inThread)).toContain("Two guests' backups failed last night.");
  expect(lastUserText(inThread)).not.toContain("how are the backups?");
  expect(toolNames(inThread)).toContain("thread_resolve");
  expect(toolNames(inThread)).not.toContain("thread_open");
  release();
  await busy;
  expect(t.chats.get(id)).toMatchObject({ outcome: "Retried both; they passed" });
  expect(t.chats.get(id)?.resolvedAt).not.toBeNull();

  const secret = { text: "hi", incognito: true };
  expect((await t.call("POST", `/conversations/${id}/messages`, secret, { cookie })).status).toBe(
    400,
  );

  await side.post("thanks").done;
  expect(t.chats.get(id)?.resolvedAt).toBeNull();
  expect((await t.call("POST", `/conversations/${id}/resolve`, {}, { cookie })).status).toBe(200);
  expect(t.chats.get(id)).toMatchObject({ outcome: null });
  expect((await t.call("POST", "/conversations/1/resolve", {}, { cookie })).status).toBe(404);

  // A new conversation in the chat hears of the thread.
  await t.thread.post("/new").done;
  await t.thread.post("hi").done;
  expect(lastUserText(model.requests.at(-1))).toContain(`#${id} \\"Backups failing\\": resolved`);
});

test(`a bot can't have more than ${MAX_OPEN_THREADS} threads open`, async () => {
  const t = await testApp(new FakeModel());
  const open = () => t.chats.openThread({ botId: "hatbot", title: "T", message: "M" });
  for (let i = 0; i < MAX_OPEN_THREADS; i++) open();
  expect(open).toThrow("Resolve some first.");
  const first = t.chats.threads(1).at(-1)?.id as number;
  t.chats.resolveThread(first, "done");
  expect(open().conversation.kind).toBe("thread");
});

test("a thread opened from a tainted chat starts tainted, and the chat that reads a tainted thread is tainted", async () => {
  const model = new FakeModel([
    { content: [text("Looking.")] },
    { content: [toolUse("thread_read", { id: 2 })] },
    { content: [text("It says so.")] },
  ]);
  const t = await testApp(model);
  const { conversation } = t.chats.openThread({
    botId: "hatbot",
    title: "Seller",
    message: "The seller wrote back.",
    taintedBy: "The chat had read: a listing",
  });
  expect(conversation.id).toBe(2);
  await t.chats.thread(2)?.post("what did they say?").done;
  const tainted = (conversationId: number) =>
    t.db
      .query<{ tainted: number }, [number]>(
        "SELECT tainted FROM episodes WHERE conversation_id = ? ORDER BY id DESC LIMIT 1",
      )
      .get(conversationId)?.tainted;
  expect(tainted(2)).toBe(1);

  await t.thread.post("what's in the seller thread?").done;
  expect(tainted(1)).toBe(1);
});

test("you open a thread on a bot's message: it starts with that message, and the chat counts the thread's unread messages", async () => {
  const model = new FakeModel([
    { content: [text("Three options:\n- A\n- B")] },
    { content: [text("B is cheaper.")] },
  ]);
  const t = await testApp(model);
  const { cookie } = signIn(t);
  await t.thread.post("options?").done;
  const [mine, reply] = t.thread.list();
  const open = (messageId: number) =>
    t.call("POST", "/conversations/1/threads", { messageId }, { cookie });
  expect((await open(mine?.id as number)).status).toBe(400);
  const res = await open(reply?.id as number);
  expect(res.status).toBe(201);
  const thread = (await res.json()) as Conversation;
  expect(thread).toMatchObject({ title: "Three options:", latest: "Three options:\n- A\n- B" });
  t.chats.markSeen(t.chats.unread());

  await t.chats.thread(thread.id)?.post("which is cheaper?").done;
  expect(t.chats.get(thread.id)?.unread).toBe(1);
  expect(t.chats.get(1)?.unread).toBe(1);
  expect(t.chats.get(thread.id)?.latest).toBe("B is cheaper.");
});

test("a background task opens a thread: you're notified, and its question and result come there, not in the chat", async () => {
  const work = new FakeModel([
    {
      content: [
        toolUse("thread_open", {
          title: "Backups failing",
          message: "Two failed.",
          key: "backups",
        }),
        toolUse("thread_open", { title: "Again", message: "Another." }),
      ],
    },
    {
      content: [
        toolUse("ask_owner", {
          questions: [{ question: "Retry?", choices: ["Yes"] }],
          wait_hours: 1,
        }),
      ],
    },
    {
      content: [
        toolUse("finish_task", { outcome: "done", summary: "Retried; both passed.", notify: true }),
      ],
    },
  ]);
  const t = await testApp(new FakeModel(), work);
  // The event that started it is untrusted: so is the thread's first message.
  const task = t.tasks.createBackgroundTask({
    title: "Check the backups",
    goal: "Check them",
    origin: "watch",
    source: "w",
    payload: '{"failed":2}',
  }) as Task;
  const question = await waitFor(() => t.questions.pending()[0]);
  const [thread] = t.chats.threads(1);
  expect(thread).toMatchObject({ title: "Backups failing", kind: "thread" });
  expect(JSON.stringify(work.requests[1]?.messages)).toContain("a task opens one thread");
  expect(t.notifier.sent.find((n) => n.title === "Backups failing")?.click).toBe(
    `https://hatbot.test/chat/1?thread=${thread?.id}`,
  );
  expect(t.chats.threadTaint(thread?.id as number, true)).toContain(`Task #${task.id}`);
  expect(question.conversationId).toBe(thread?.id as number);

  await t.questions.answer(question.id, "Yes");
  await ended(t, task.id);
  const side = t.chats.thread(thread?.id as number);
  expect(side?.list().find((m) => m.kind === "task")).toMatchObject({ taskId: task.id });
  expect(t.thread.list().map((m) => m.kind)).toEqual(["thread"]);
});

test("a thread's key keeps one open thread per subject, and a task writes in one by key", async () => {
  const work = new FakeModel([
    { content: [toolUse("thread_post", { key: "nas", message: "Disk 2 again." })] },
    { content: [toolUse("thread_post", { key: "backups", message: "Still failing." })] },
    finish(),
  ]);
  const t = await testApp(new FakeModel(), work);
  const open = () =>
    t.chats.openThread({ botId: "hatbot", title: "Backups", message: "Failed.", key: "backups" });
  const first = open();
  expect(open()).toMatchObject({ opened: false, conversation: { id: first.conversation.id } });
  t.chats.resolveThread(first.conversation.id, "fixed");
  const second = open();
  expect(second.opened).toBe(true);

  const task = scheduled(t, "Check");
  await ended(t, task.id);
  expect(JSON.stringify(work.requests[1]?.messages)).toContain(
    'No open thread with the key \\"nas\\"',
  );
  expect(t.chats.thread(second.conversation.id)?.list().at(-1)?.text).toBe("Still failing.");
});

test("you open a thread on a task's card once the task has ended", async () => {
  const { promise: slow, resolve: release } = Promise.withResolvers<void>();
  const work = new FakeModel([{ ...finish("Both backups passed."), wait: slow }]);
  const t = await testApp(new FakeModel(), work);
  const { cookie } = signIn(t);
  const task = scheduled(t, "Check the backups");
  const card = t.chats.addCard(1, "hatbot", "task", `Task #${task.id}`, { taskId: task.id });
  const open = () => t.call("POST", "/conversations/1/threads", { messageId: card.id }, { cookie });
  expect((await open()).status).toBe(400);
  release();
  await ended(t, task.id);
  const res = await open();
  expect(res.status).toBe(201);
  expect(await res.json()).toMatchObject({
    title: "Check the backups",
    latest: "Both backups passed.",
  });
});

test("a thread a bot marks as needing you shows so until you write in it, and a task's mark notifies you", async () => {
  const work = new FakeModel([
    {
      content: [
        toolUse("thread_post", { key: "backups", message: "Retry them?", needs_you: true }),
      ],
    },
    finish(),
  ]);
  const t = await testApp(
    new FakeModel([{ content: [text("Hi.")] }, { content: [text("Retrying.")] }]),
    work,
  );
  const { conversation } = t.chats.openThread({
    botId: "hatbot",
    title: "Backups",
    message: "Failed.",
    key: "backups",
  });
  const id = conversation.id;
  expect(conversation.needsYou).toBe(false);
  const task = scheduled(t, "Check");
  await ended(t, task.id);
  expect(t.chats.get(id)?.needsYou).toBe(true);
  expect(t.notifier.sent.map((n) => n.click)).toContain(`https://hatbot.test/chat/1?thread=${id}`);

  // It comes first among the open threads, and the chat knows it's waiting.
  t.advance(60_000);
  t.chats.openThread({ botId: "hatbot", title: "Other", message: "News." });
  expect(t.chats.threads(1)[0]?.id).toBe(id);
  await t.thread.post("hi").done;
  expect(lastUserText(t.model.requests.at(-1))).toContain(
    `#${id} \\"Backups\\": open, waiting for the owner`,
  );

  await t.chats.thread(id)?.post("yes, retry").done;
  expect(t.chats.get(id)?.needsYou).toBe(false);

  const asked = t.chats.openThread({ botId: "hatbot", title: "Q", message: "?", needsYou: true });
  expect(asked.conversation.needsYou).toBe(true);
  expect(t.chats.resolveThread(asked.conversation.id, null)?.needsYou).toBe(false);
});
