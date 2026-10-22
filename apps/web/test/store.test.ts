import { expect, test } from "bun:test";
import type { Approval, Proposal, Task, ThreadMessage } from "@hatbot/shared";
import { FakeSocket, installDom, type Request, settle } from "./dom";
import { msg } from "./fixtures";

const dom = installDom();
dom.answer(() => []);

const freshStore = (name: string) =>
  import(`../src/store.ts?${name}`) as Promise<typeof import("../src/store")>;

const shown = (s: { getState(): { messages: ThreadMessage[] } }) =>
  s.getState().messages.map((m) => [m.id, m.text, m.status]);
const asked = (pattern: RegExp) => dom.requests.filter((r) => pattern.test(r.path));
/** Answers the thread's pages with `thread`, and everything else as `rest` says, or with []. */
const serve = (thread: (r: Request) => unknown, rest: (r: Request) => unknown = () => []) =>
  dom.answer((r) => (/^\/conversations\/1\/messages/.test(r.path) ? thread(r) : rest(r)));
/** The stream drops and comes back, and the store catches up. */
async function reconnect(store: { reconnectNow(): void }) {
  FakeSocket.last.close();
  store.reconnectNow();
  FakeSocket.last.open();
  await settle();
  await settle();
}

test("events that come while the thread loads are put onto what it loaded", async () => {
  const store = await freshStore("loading");
  store.connect();
  const socket = FakeSocket.last;
  socket.open();
  const page = Promise.withResolvers<ThreadMessage[]>();
  serve(() => page.promise);
  const loading = store.loadThread();
  await settle();
  // The page was read while the reply streamed; it finished before the page arrived.
  socket.emit({ type: "message.delta", id: 2, text: "Hel" });
  socket.emit({ type: "message.delta", id: 2, text: "lo" });
  socket.emit({ type: "message.done", id: 2, text: "Hello.", status: "done" });
  socket.emit({ type: "message.created", message: msg(3, { role: "user", botId: null }) });
  socket.emit({ type: "message.created", message: msg(4, { text: "", status: "streaming" }) });
  socket.emit({ type: "message.delta", id: 4, text: "Wor" });
  page.resolve([msg(1), msg(2, { text: "", status: "streaming" })]);
  await loading;
  dom.flushFrames();
  expect(shown(store)).toEqual([
    [1, "Message 1", "done"],
    [2, "Hello.", "done"],
    [3, "Message 3", "done"],
    [4, "Wor", "streaming"],
  ]);
  // Later deltas carry on from there, once.
  socket.emit({ type: "message.delta", id: 4, text: "king" });
  dom.flushFrames();
  expect(shown(store).at(-1)).toEqual([4, "Working", "streaming"]);
  store.disconnect();
});

test("text a page read mid-reply already has isn't put onto it again", async () => {
  const store = await freshStore("loading-mid-reply");
  store.connect();
  const socket = FakeSocket.last;
  socket.open();
  const page = Promise.withResolvers<ThreadMessage[]>();
  serve(() => page.promise);
  const loading = store.loadThread();
  await settle();
  // The brain served the reply as far as "Hel"; both deltas came while the page was on its way.
  socket.emit({ type: "message.delta", id: 2, text: "Hel", at: 0 });
  socket.emit({ type: "message.delta", id: 2, text: "lo", at: 3 });
  page.resolve([msg(1), msg(2, { text: "Hel", status: "streaming" })]);
  await loading;
  dom.flushFrames();
  expect(shown(store).at(-1)).toEqual([2, "Hello", "streaming"]);
  socket.emit({ type: "message.delta", id: 2, text: " there", at: 5 });
  dom.flushFrames();
  expect(shown(store).at(-1)).toEqual([2, "Hello there", "streaming"]);
  store.disconnect();
});

test("the stream's first open catches the thread up too, and takes what's live from its first event", async () => {
  const store = await freshStore("first-open");
  // The thread loaded before the stream opened, and the reply finished in between.
  serve(() => [msg(1), msg(2, { text: "", status: "streaming" })]);
  await store.loadThread();
  expect(shown(store).at(-1)).toEqual([2, "", "streaming"]);
  serve(() => [msg(1), msg(2, { text: "Done.", status: "done" })]);
  store.connect();
  FakeSocket.last.open();
  await settle();
  expect(shown(store).at(-1)).toEqual([2, "Done.", "done"]);

  // Its first event says what's live, so none of it is asked for; a brain from before it is asked.
  const live = /^\/(approvals|questions|desktop|thread\/unread|bots)/;
  const from = dom.requests.length;
  FakeSocket.last.emit({
    type: "snapshot",
    paused: true,
    bots: [],
    conversations: [],
    approvals: [{ id: 3, status: "pending" } as Approval],
    questions: [],
    desktop: { online: true, control: "hatbot", request: null, activeTaskId: null, botId: null },
    unread: [2],
  });
  await settle();
  expect(store.getState()).toMatchObject({
    paused: true,
    unread: [2],
    approvals: { 3: { id: 3 } },
  });
  expect(dom.requests.slice(from).filter((r) => live.test(r.path))).toEqual([]);
  await reconnect(store);
  FakeSocket.last.emit({ type: "paused", paused: false });
  await settle();
  expect(dom.requests.slice(from).filter((r) => live.test(r.path))).not.toEqual([]);
  store.disconnect();
});

test("Earlier messages loads once however often it's asked, and never into incognito", async () => {
  const store = await freshStore("earlier");
  const latest = Array.from({ length: 50 }, (_, i) => msg(51 + i));
  const older = Promise.withResolvers<ThreadMessage[]>();
  serve((r) => (r.path.includes("before=51") ? older.promise : latest));
  await store.loadThread();
  expect(store.getState().hasEarlier).toBe(true);
  const a = store.loadEarlier();
  const b = store.loadEarlier();
  expect(b).toBe(a);
  older.resolve(Array.from({ length: 50 }, (_, i) => msg(1 + i)));
  await Promise.all([a, b]);
  expect(asked(/before=51/)).toHaveLength(1);
  const ids = store.getState().messages.map((m) => m.id);
  expect(ids).toHaveLength(100);
  expect(new Set(ids).size).toBe(100);

  // Into incognito while the page before loads: the normal history stays out of it.
  const first = await freshStore("earlier-incognito");
  serve((r) => (r.path.includes("before=51") ? older.promise : latest));
  await first.loadThread();
  const page = Promise.withResolvers<ThreadMessage[]>();
  serve((r) => (r.path.includes("before=51") ? page.promise : []));
  const loading = first.loadEarlier();
  await first.setIncognito(true);
  page.resolve(Array.from({ length: 50 }, (_, i) => msg(1 + i)));
  await loading;
  expect(first.getState()).toMatchObject({ incognito: true, messages: [] });
  await first.setIncognito(false);
});

const task = (id: number): Task => ({ id, title: "Check the NAS", status: "done" }) as Task;

test("a card whose fetch failed is fetched again after a reconnect", async () => {
  const store = await freshStore("cards");
  let down = true;
  serve(
    () => [msg(5, { kind: "task", taskId: 12, text: "Task #12: Check the NAS" })],
    (r) => {
      if (!r.path.startsWith("/tasks?ids=12")) return [];
      if (down) throw { status: 502, error: "Bad gateway" };
      return [task(12)];
    },
  );
  store.connect();
  FakeSocket.last.open();
  await store.loadThread();
  store.ensureTask(12);
  await settle();
  expect(store.getState().tasks[12]).toBeUndefined();
  // The card asks once, when it's first shown; the reconnect asks again.
  down = false;
  await reconnect(store);
  expect(store.getState().tasks[12]?.title).toBe("Check the NAS");
  store.disconnect();
});

test("a reconnect reloads what may have changed while the stream was down", async () => {
  const store = await freshStore("reconnect");
  const proposal = (id: number, status: Proposal["status"]) => ({ id, status }) as Proposal;
  let away = false;
  serve(
    () => [],
    (r) => {
      if (r.path === "/proposals?status=pending") return away ? [proposal(8, "pending")] : [];
      if (r.path === "/proposals") return away ? [proposal(8, "pending")] : [];
      if (r.path === "/plugins") return [{ id: "ssh", enabled: away }];
      if (r.path === "/negotiations/4")
        return {
          negotiation: { id: 4, status: "open" },
          messages: away ? [{ id: 1 }, { id: 2 }] : [{ id: 1 }],
        };
      return [];
    },
  );
  store.connect();
  FakeSocket.last.open();
  // Memory loaded no proposals; a negotiation's page is open.
  await store.loadProposals();
  await store.loadPlugins();
  await store.loadNegotiation(4);
  const before = store.getState();
  // Meanwhile a proposal was made, a plugin turned on on the phone, and the seller answered.
  away = true;
  await reconnect(store);
  const after = store.getState();
  expect(after.settingsVersion).toBe(before.settingsVersion + 1);
  expect(after.memoryVersion).toBe(before.memoryVersion + 1);
  expect(after.heartbeatVersion).toBe(before.heartbeatVersion + 1);
  expect(after.proposals[8]?.status).toBe("pending");
  expect(after.plugins.ssh?.enabled).toBe(true);
  expect(after.negotiationMessages[4]).toHaveLength(2);
  store.disconnect();
});

test("a reloaded incognito chat stays incognito, and only that chat", async () => {
  // This tab was incognito in chat 5 when it was reloaded.
  dom.storage.setItem("hatbot:incognito", "5");
  dom.answer(() => []);
  const store = await freshStore("incognito");
  const from = dom.requests.length;
  expect(store.getState()).toMatchObject({ conversationId: 5, incognito: true });
  await store.openConversation(5);
  expect(store.getState()).toMatchObject({ conversationId: 5, incognito: true });
  await store.loadThread();
  expect(dom.requests.slice(from).map((r) => `${r.method} ${r.path}`)).toEqual([
    "GET /conversations/5/messages?limit=50&incognito=1",
  ]);

  // Going to another chat leaves it, which deletes its conversation.
  await store.openConversation(1);
  expect(store.getState()).toMatchObject({ conversationId: 1, incognito: false });
  expect(dom.requests.at(-1)).toMatchObject({
    method: "DELETE",
    path: "/conversations/5/incognito",
  });
  expect(dom.storage.getItem("hatbot:incognito")).toBeNull();

  // Incognito in Hatbot's chat: the tab remembers which chat.
  await store.setIncognito(true);
  expect(dom.storage.getItem("hatbot:incognito")).toBe("1");
  await store.setIncognito(false);
  expect(dom.storage.getItem("hatbot:incognito")).toBeNull();
  expect(dom.requests.at(-1)).toMatchObject({
    method: "DELETE",
    path: "/conversations/1/incognito",
  });
});
