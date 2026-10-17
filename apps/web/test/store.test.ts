import { expect, test } from "bun:test";
import type { Proposal, Task, ThreadMessage } from "@hatbot/shared";
import { FakeSocket, installDom, later, type Request, settle } from "./dom";

const dom = installDom();
dom.answer(() => []);

/** A store of its own, as a fresh page load has. */
const freshStore = (name: string) =>
  import(`../src/store.ts?${name}`) as Promise<typeof import("../src/store")>;

const msg = (id: number, patch: Partial<ThreadMessage> = {}): ThreadMessage => ({
  id,
  role: "assistant",
  conversationId: 1,
  botId: "hatbot",
  kind: "text",
  text: `Message ${id}`,
  status: "done",
  createdAt: "2026-10-17T10:00:00.000Z",
  taskId: null,
  scheduleId: null,
  negotiationId: null,
  episodeId: null,
  editedAt: null,
  seenAt: "2026-10-17T10:00:00.000Z",
  ...patch,
});
const shown = (s: { getState(): { messages: ThreadMessage[] } }) =>
  s.getState().messages.map((m) => [m.id, m.text, m.status]);
const asked = (pattern: RegExp) => dom.requests.filter((r) => pattern.test(r.path));
/** Answers the thread's pages with `thread`, and everything else as `rest` says, or with []. */
const serve = (thread: (r: Request) => unknown, rest: (r: Request) => unknown = () => []) =>
  dom.answer((r) => (/^\/conversations\/1\/messages/.test(r.path) ? thread(r) : rest(r)));

test("events that come while the thread loads are put onto what it loaded", async () => {
  const store = await freshStore("loading");
  store.connect();
  const socket = FakeSocket.last;
  socket.open();
  const page = later<ThreadMessage[]>();
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

test("the stream's first open catches the thread up too", async () => {
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
  store.disconnect();
});

test("Earlier messages loads once however often it's asked, and never into incognito", async () => {
  const store = await freshStore("earlier");
  const latest = Array.from({ length: 50 }, (_, i) => msg(51 + i));
  const older = later<ThreadMessage[]>();
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
  const page = later<ThreadMessage[]>();
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
  FakeSocket.last.close();
  store.reconnectNow();
  FakeSocket.last.open();
  await settle();
  await settle();
  expect(store.getState().tasks[12]?.title).toBe("Check the NAS");
  store.disconnect();
});

test("a reconnect reloads settings, memory, the heartbeat, proposals and plugins", async () => {
  const store = await freshStore("reconnect");
  const proposal = (id: number, status: Proposal["status"]) => ({ id, status }) as Proposal;
  let answered = false;
  serve(
    () => [],
    (r) => {
      if (r.path === "/proposals?status=pending") return answered ? [] : [proposal(7, "pending")];
      if (r.path === "/proposals") return [proposal(7, answered ? "applied" : "pending")];
      if (r.path === "/plugins") return [{ id: "ssh", enabled: answered }];
      return [];
    },
  );
  store.connect();
  FakeSocket.last.open();
  await store.loadProposals();
  await store.loadPlugins();
  const before = store.getState();
  // While the stream was down, the proposal was applied on the phone and a plugin turned on.
  answered = true;
  FakeSocket.last.close();
  store.reconnectNow();
  FakeSocket.last.open();
  await settle();
  await settle();
  const after = store.getState();
  expect(after.settingsVersion).toBe(before.settingsVersion + 1);
  expect(after.memoryVersion).toBe(before.memoryVersion + 1);
  expect(after.heartbeatVersion).toBe(before.heartbeatVersion + 1);
  expect(after.proposals[7]?.status).toBe("applied");
  expect(after.plugins.ssh?.enabled).toBe(true);
  store.disconnect();
});
