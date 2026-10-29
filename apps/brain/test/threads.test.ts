import { expect, test } from "bun:test";
import { type Conversation, MAX_OPEN_THREADS } from "@hatbot/shared";
import { FakeModel, text, toolUse } from "./fake-model";
import { lastUserText, requested, signIn, testApp, toolNames } from "./helpers";

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
