import {
  API_PREFIX,
  type Approval,
  type ApprovalScope,
  type Attachment,
  type Bot,
  type Box,
  type ComputerInfo,
  type Conversation,
  type DesktopState,
  type Episode,
  type HatbotEvent,
  keepLines,
  type Me,
  type MessageChanges,
  type Negotiation,
  type NegotiationDetail,
  type NegotiationMessage,
  type PluginInfo,
  type Proposal,
  type Question,
  type Schedule,
  type Snapshot,
  type SpendSummary,
  type Task,
  type TaskCard,
  type TaskStep,
  type TeachSession,
  type ThreadMessage,
  type Trigger,
  type Watcher,
} from "@hatbot/shared";
import { useSyncExternalStore } from "react";
import { ApiError, api } from "./api";
import { withDelta } from "./delta";
import type { Toast } from "./toast";
import { needsYouIn } from "./waiting";

/** A thread open beside the chat. */
type Pane = { conversationId: number; messages: ThreadMessage[]; hasEarlier: boolean };
/** Which chat a list of messages is: the chat's own, or the thread beside it. */
type Where = { conversationId: number; incognito: boolean };

type State = {
  conversationId: number;
  incognito: boolean;
  messages: ThreadMessage[];
  episodes: Record<number, Episode>;
  progress: Record<number, string>;
  usage: Record<number, { tokens: number; costUsd: number }>;
  hasEarlier: boolean;
  /** Hatbot's messages sent or edited since you last saw them. */
  unread: number[];
  paused: boolean;
  todayUsd: number | null;
  monthUsd: number | null;
  memoryVersion: number;
  /** Bumped when settings change anywhere, and after each heartbeat: pages showing them refetch. */
  settingsVersion: number;
  heartbeatVersion: number;
  connected: boolean;
  /** Cards (TaskCard) until a task's page or an event brings the whole task. */
  tasks: Record<number, Task | TaskCard>;
  steps: Record<number, TaskStep[]>;
  taskFiles: Record<number, Attachment[]>;
  taskProgress: Record<number, string>;
  approvals: Record<number, Approval>;
  questions: Record<number, Question>;
  desktop: DesktopState | null;
  /** Your own computers, as the Your computers plugin knows them. */
  computers: ComputerInfo[];
  /** null: deleted, or never existed. */
  schedules: Record<number, Schedule | null>;
  triggers: Record<number, Trigger | null>;
  watchers: Record<number, Watcher | null>;
  /** The open ones, and any a chat or page has shown. */
  negotiations: Record<number, Negotiation>;
  negotiationMessages: Record<number, NegotiationMessage[]>;
  /** All of them once Boxes has been opened, and any a chat has shown. null: deleted. */
  boxes: Record<number, Box | null>;
  plugins: Record<string, PluginInfo>;
  /** Memory changes waiting for you, and ones you've answered this session. */
  proposals: Record<number, Proposal>;
  teach: Record<number, TeachSession>;
  /** Deleted ones too once seen: old messages still name them. Brief (`Bot.brief`) as listed. */
  bots: Record<string, Bot>;
  /** Bots that aren't deleted, Hatbot first. */
  botIds: string[];
  /** Your chats: each bot's own, then groups. */
  conversations: Conversation[];
  side: Pane | null;
  /** The threads of the chats you've opened, by id. */
  threads: Record<number, Conversation>;
};

/** Hatbot's own chat: the first one, made with the database. */
export const HATBOT_CHAT = 1;
/** Hatbot's chat is the app's front page. */
export const chatPath = (id: number) => (id === HATBOT_CHAT ? "/" : `/chat/${id}`);
/** A thread opens beside its chat. */
export const threadPath = (t: Pick<Conversation, "id" | "parentId">) =>
  `${chatPath(t.parentId ?? HATBOT_CHAT)}?thread=${t.id}`;
/** Where a chat or a thread is. */
export const pathOf = (c: Conversation) => (c.kind === "thread" ? threadPath(c) : chatPath(c.id));

/** The chat that's incognito in this tab, so a reload stays incognito in it and only in it. */
const INCOGNITO_KEY = "hatbot:incognito";
const incognitoChat = Number(sessionStorage.getItem(INCOGNITO_KEY)) || 0;

let state: State = {
  conversationId: incognitoChat || HATBOT_CHAT,
  incognito: incognitoChat > 0,
  messages: [],
  episodes: {},
  progress: {},
  usage: {},
  hasEarlier: false,
  unread: [],
  paused: false,
  todayUsd: null,
  monthUsd: null,
  memoryVersion: 0,
  settingsVersion: 0,
  heartbeatVersion: 0,
  connected: false,
  tasks: {},
  steps: {},
  taskFiles: {},
  taskProgress: {},
  approvals: {},
  questions: {},
  desktop: null,
  computers: [],
  schedules: {},
  triggers: {},
  watchers: {},
  negotiations: {},
  negotiationMessages: {},
  boxes: {},
  plugins: {},
  proposals: {},
  teach: {},
  bots: {},
  botIds: [],
  conversations: [],
  side: null,
  threads: {},
};
const listeners = new Set<() => void>();
const set = (patch: Partial<State>) => {
  state = { ...state, ...patch };
  for (const l of listeners) l();
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

type MapKey = {
  [K in keyof State]: State[K] extends unknown[]
    ? never
    : State[K] extends Record<number, unknown>
      ? K
      : never;
}[keyof State];
type Id<K extends MapKey> = keyof State[K];
type Entry<K extends MapKey> = State[K][Id<K>];

function put<K extends MapKey>(key: K, id: Id<K>, v: Entry<K>) {
  set({ [key]: { ...state[key], [id]: v } });
}
function merge<K extends MapKey>(key: K, list: (NonNullable<Entry<K>> & { id: Id<K> })[]) {
  set({ [key]: { ...state[key], ...Object.fromEntries(list.map((x) => [x.id, x])) } });
}

export function useStore<T>(select: (s: State) => T): T {
  const snapshot = () => select(state);
  // The second snapshot is for rendering to a string, which the tests do.
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
export const getState = () => state;

const PAGE = 50;
// A message gets its conversation after it's posted; the POST's answer can land after that news and
// mustn't take it away again, or the message files under the folded conversation before it.
const upsert = (list: ThreadMessage[], m: ThreadMessage) =>
  list.some((x) => x.id === m.id)
    ? list.map((x) => (x.id === m.id ? { ...x, ...m, episodeId: m.episodeId ?? x.episodeId } : x))
    : [...list, m].sort((a, b) => a.id - b.id);

async function loadEpisodes(messages: ThreadMessage[], conversationId: number) {
  const ids = [...new Set(messages.map((m) => m.episodeId))].filter(
    (id): id is number => id !== null && !state.episodes[id],
  );
  if (!ids.length) return;
  const list = await api<Episode[]>(
    `/conversations/${conversationId}/episodes?ids=${ids.join(",")}`,
  );
  merge("episodes", list);
}

const page = (w: Where, before?: number) =>
  `/conversations/${w.conversationId}/messages?limit=${PAGE}${before ? `&before=${before}` : ""}${w.incognito ? "&incognito=1" : ""}`;

const mainWhere = (): Where => ({
  conversationId: state.conversationId,
  incognito: state.incognito,
});
const sideWhere = (): Where | null =>
  state.side && { conversationId: state.side.conversationId, incognito: false };
const whereOf = (side: boolean) => (side ? sideWhere() : mainWhere());
const sameWhere = (a: Where | null, b: Where | null) =>
  !!a && !!b && a.conversationId === b.conversationId && a.incognito === b.incognito;
const listOf = (side: boolean) => (side ? (state.side?.messages ?? []) : state.messages);
/** The pane's messages, and whether there are earlier ones. */
function setList(side: boolean, messages: ThreadMessage[], hasEarlier?: boolean) {
  if (!side) return set({ messages, ...(hasEarlier === undefined ? {} : { hasEarlier }) });
  if (state.side)
    set({ side: { ...state.side, messages, hasEarlier: hasEarlier ?? state.side.hasEarlier } });
}

// Message events that come while a page of messages loads: the page was read before them, so they're
// put onto it again, or a reply that finished meanwhile would stay streaming.
const missed = new Set<HatbotEvent[]>();

async function messagesPage(w: Where, before?: number) {
  const events: HatbotEvent[] = [];
  missed.add(events);
  try {
    const list = await api<ThreadMessage[]>(page(w, before));
    await loadEpisodes(list, w.conversationId).catch(() => {});
    return { list, events };
  } finally {
    missed.delete(events);
  }
}

/** Deltas still waiting for a frame are among the events. A reply being written brings its progress. */
function caughtUp(list: ThreadMessage[], events: HatbotEvent[], w: Where) {
  flushDeltas();
  for (const m of list) if (m.progress) put("progress", m.id, m.progress);
  return events.reduce((l, e) => onMessages(l, e, w), list);
}

/** A chat has been shown: the stream's first open catches its thread up too. */
let threadShown = false;

/** `side`: the thread beside the chat. */
export async function loadThread(side = false) {
  if (!side) threadShown = true;
  const w = whereOf(side);
  if (!w) return;
  const { list, events } = await messagesPage(w);
  // Switched while it loaded: the other conversation's load wins.
  if (!sameWhere(w, whereOf(side))) return;
  setList(side, caughtUp(list, events, w), list.length === PAGE);
}

const earlier = new Map<boolean, Promise<void>>();
/** Asked for again while it loads, it's the same load. */
export function loadEarlier(side = false): Promise<void> {
  const loading =
    earlier.get(side) ??
    (async () => {
      const first = listOf(side)[0];
      const w = whereOf(side);
      if (!first || !w) return;
      const { list, events } = await messagesPage(w, first.id);
      // Switched, to incognito too, or loaded again from the bottom: it doesn't go on the top any more.
      if (!sameWhere(w, whereOf(side)) || listOf(side)[0]?.id !== first.id) return;
      const have = new Set(listOf(side).map((m) => m.id));
      const older = caughtUp(list, events, w).filter((m) => !have.has(m.id));
      setList(side, [...older, ...listOf(side)], list.length === PAGE);
    })().finally(() => {
      earlier.delete(side);
    });
  earlier.set(side, loading);
  return loading;
}

/** `clientId`: sent again with it after the answer was lost, the brain posts it once. */
export async function sendMessage(
  text: string,
  attachmentIds: number[] = [],
  clientId?: string,
  side = false,
) {
  const w = whereOf(side);
  if (!w) return;
  const m = await api<ThreadMessage>(`/conversations/${w.conversationId}/messages`, {
    body: { text, attachmentIds, incognito: w.incognito, clientId },
    timeout: 30_000,
  });
  const now = whereOf(side);
  if (now && !!m.incognito === now.incognito && m.conversationId === now.conversationId)
    setList(side, upsert(listOf(side), m));
}

/** It's rewritten in place, through the usual events. */
export async function retryReply(m: ThreadMessage) {
  await api(`/conversations/${m.conversationId}/messages/${m.id}/retry`, { body: {} });
}

/** message.deleted takes it off the screen. */
export async function deleteEpisode(id: number, conversationId = state.conversationId) {
  await api(`/conversations/${conversationId}/episodes/${id}`, { method: "DELETE" });
}

/** Opens a thread beside the chat, or closes it (null). */
export function openSide(id: number | null) {
  if ((state.side?.conversationId ?? null) === id) return;
  set({ side: id === null ? null : { conversationId: id, messages: [], hasEarlier: false } });
}

export async function loadThreads(parentId: number) {
  const list = await api<Conversation[]>(`/conversations/${parentId}/threads`);
  const kept = Object.values(state.threads).filter((t) => t.parentId !== parentId);
  set({ threads: Object.fromEntries([...kept, ...list].map((t) => [t.id, t])) });
}

/** A chat or thread on its own, e.g. one a link names. */
export async function loadConversation(id: number) {
  const c = await api<Conversation>(`/conversations/${id}`);
  putConversation(c);
  return c;
}

export async function resolveThread(id: number) {
  putConversation(await api<Conversation>(`/conversations/${id}/resolve`, { body: {} }));
}

/** A thread that starts with this message of the bot's. */
export async function replyInThread(m: ThreadMessage) {
  const c = await api<Conversation>(`/conversations/${m.conversationId}/threads`, {
    body: { messageId: m.id },
  });
  putConversation(c);
  return c;
}

/** Out of incognito deletes its conversation. */
export async function setIncognito(on: boolean) {
  if (on === state.incognito) return;
  if (on) sessionStorage.setItem(INCOGNITO_KEY, String(state.conversationId));
  else sessionStorage.removeItem(INCOGNITO_KEY);
  set({ incognito: on, messages: [], hasEarlier: false });
  if (!on)
    await api(`/conversations/${state.conversationId}/incognito`, { method: "DELETE" }).catch(
      () => {},
    );
}

/**
 * Shows another chat. Leaving one in incognito deletes its conversation; the one this tab was
 * incognito in, reloaded, stays so.
 */
export async function openConversation(id: number) {
  if (id === state.conversationId) return;
  const left = state.conversationId;
  const wasIncognito = state.incognito;
  sessionStorage.removeItem(INCOGNITO_KEY);
  set({ conversationId: id, incognito: false, messages: [], hasEarlier: false });
  if (wasIncognito)
    await api(`/conversations/${left}/incognito`, { method: "DELETE" }).catch(() => {});
}

export async function loadBots() {
  const [bots, conversations] = await Promise.all([
    api<Bot[]>("/bots?brief=1"),
    api<Conversation[]>("/conversations"),
  ]);
  takeBots(bots, conversations);
}
function takeBots(bots: Bot[], conversations: Conversation[]) {
  merge("bots", bots);
  set({ botIds: bots.map((b) => b.id), conversations });
}
export async function loadBot(id: string) {
  const bot = await api<Bot>(`/bots/${id}`);
  putBot(bot);
  return bot;
}

let refreshing: ReturnType<typeof setTimeout> | null = null;
/** Debounced: news comes in bursts. */
function refreshConversations() {
  if (refreshing) return;
  refreshing = setTimeout(() => {
    refreshing = null;
    api<Conversation[]>("/conversations").then(
      (conversations) => set({ conversations }),
      () => {},
    );
    // A thread's latest message and unread count.
    if (Object.values(state.threads).some((t) => t.parentId === state.conversationId))
      void loadThreads(state.conversationId).catch(() => {});
  }, 300);
}

export async function createBot(body: Partial<Bot> & { name: string }) {
  const bot = await api<Bot>("/bots", { body });
  putBot(bot);
  await loadBots();
  return bot;
}
export async function saveBot(id: string, patch: Partial<Bot>) {
  const bot = await api<Bot>(`/bots/${id}`, { method: "PATCH", body: patch });
  putBot(bot);
  return bot;
}
export async function deleteBot(id: string) {
  await api(`/bots/${id}`, { method: "DELETE" });
  set({ botIds: state.botIds.filter((b) => b !== id) });
  await loadBots();
}
export async function createGroup(body: { title: string; botIds: string[] }) {
  const c = await api<Conversation>("/conversations", { body });
  putConversation(c);
  return c;
}
export async function saveGroup(id: number, patch: { title?: string; botIds?: string[] }) {
  putConversation(
    await api<Conversation>(`/conversations/${id}`, { method: "PATCH", body: patch }),
  );
}
export async function deleteGroup(id: number) {
  await api(`/conversations/${id}`, { method: "DELETE" });
  set({ conversations: state.conversations.filter((c) => c.id !== id) });
}
const putConversation = (c: Conversation) =>
  c.kind === "thread"
    ? put("threads", c.id, c)
    : set({
        conversations: state.conversations.some((x) => x.id === c.id)
          ? state.conversations.map((x) => (x.id === c.id ? c : x))
          : [...state.conversations, c],
      });
const putBot = (b: Bot) => {
  put("bots", b.id, b);
  if (!state.botIds.includes(b.id)) set({ botIds: [...state.botIds, b.id] });
};

export const botName = (s: State, id: string | null | undefined) =>
  id ? (s.bots[id]?.name ?? id) : "";
export const chatName = (s: State, c: Conversation | undefined) =>
  !c
    ? "Chat"
    : c.kind === "group"
      ? c.title || c.botIds.map((id) => botName(s, id)).join(", ")
      : c.kind === "thread"
        ? c.title || "Thread"
        : botName(s, c.botIds[0]);
export const currentChat = (s: State) => s.conversations.find((c) => c.id === s.conversationId);

/** Messages in an incognito conversation: they're never unread. */
const incognitoIds = new Set<number>();
const addUnread = (id: number) =>
  state.unread.includes(id) || incognitoIds.has(id)
    ? state.unread
    : [...state.unread, id].sort((a, b) => a - b);

/** They stop counting as unread here and on your other devices. */
export function markSeen(ids: number[]) {
  const seen = ids.filter((id) => state.unread.includes(id));
  if (!seen.length) return;
  set({ unread: state.unread.filter((id) => !seen.includes(id)) });
  void api("/thread/seen", { body: { ids: seen } }).catch(() => {});
}

export async function setPaused(paused: boolean) {
  await api(paused ? "/pause-all" : "/resume", { body: {} });
  set({ paused });
}

export function bumpMemory() {
  set({ memoryVersion: state.memoryVersion + 1 });
}

/** A task with its steps. `since`: only the steps after the ones we have; a brain from before sends all. */
export async function loadTask(id: number, { since = false } = {}) {
  const had = since ? state.steps[id] : undefined;
  const after = had?.at(-1)?.id;
  const { task, steps, attachments } = await api<{
    task: Task;
    steps: TaskStep[];
    attachments?: Attachment[];
  }>(`/tasks/${id}${after === undefined ? "" : `?afterStep=${after}`}`);
  put("tasks", id, task);
  const fresh = new Set(steps.map((x) => x.id));
  const kept = (had ?? []).filter((x) => !fresh.has(x.id));
  put(
    "steps",
    id,
    [...kept, ...steps].sort((a, b) => a.id - b.id),
  );
  put("taskFiles", id, attachments ?? []);
}

const requested = new Set<string>();
/** Runs `load` once for `key`, unless `have`; after a failure, the next ask runs it again. */
function once(key: string, have: boolean, load: () => Promise<unknown>) {
  if (have || requested.has(key)) return;
  requested.add(key);
  load().catch(() => requested.delete(key));
}
let wanted: number[] = [];
/** A chat's task cards come in one request. */
export function ensureTask(id: number) {
  if (state.tasks[id] || requested.has(`t${id}`)) return;
  requested.add(`t${id}`);
  if (!wanted.length) queueMicrotask(loadWanted);
  wanted.push(id);
}
function loadWanted() {
  const ids = wanted;
  wanted = [];
  for (let i = 0; i < ids.length; i += 200) {
    const some = ids.slice(i, i + 200);
    loadTasks({ ids: some, view: "card" }).catch(() => {
      for (const id of some) requested.delete(`t${id}`);
    });
  }
}
export const ensureSteps = (id: number) => once(`st${id}`, !!state.steps[id], () => loadTask(id));
export const ensureApproval = (id: number) =>
  once(`a${id}`, !!state.approvals[id], () => loadApproval(id));
export async function loadApproval(id: number) {
  const a = await api<Approval>(`/approvals/${id}`);
  put("approvals", a.id, a);
  return a;
}

export async function loadTasks(
  filter: {
    status?: "active" | "done";
    /** Paging: only tasks older than this one, at most `limit`. */
    before?: number;
    limit?: number;
    scheduleId?: number;
    triggerId?: number;
    watcherId?: number;
    ids?: number[];
    view?: "card";
  } = {},
) {
  const q = new URLSearchParams(
    Object.entries(filter).flatMap(([k, v]) => (v === undefined ? [] : [[k, String(v)]])),
  ).toString();
  const list = await api<(Task | TaskCard)[]>(`/tasks${q ? `?${q}` : ""}`);
  // A card doesn't take away what a whole task we have says that it leaves out.
  merge(
    "tasks",
    list.map((t) => ({ ...state.tasks[t.id], ...t })),
  );
  return list.map((t) => t.id);
}

export async function loadSchedules() {
  const [schedules, triggers, watchers] = await Promise.all([
    api<Schedule[]>("/schedules"),
    api<Trigger[]>("/triggers"),
    api<Watcher[]>("/watchers"),
  ]);
  merge("schedules", schedules);
  merge("triggers", triggers);
  merge("watchers", watchers);
  return {
    schedules: schedules.map((s) => s.id),
    triggers: triggers.map((t) => t.id),
    watchers: watchers.map((w) => w.id),
  };
}

export const ensureSchedule = (id: number) =>
  once(`s${id}`, id in state.schedules, () =>
    api<Schedule>(`/schedules/${id}`).then(putSchedule, (err) => {
      if (!(err instanceof ApiError && err.status === 404)) throw err;
      put("schedules", id, null);
    }),
  );

/** False only once it's known to be off, so nothing hides while the list loads. */
export const pluginOn = (plugins: Record<string, PluginInfo>, id: string) =>
  plugins[id]?.enabled !== false;

/** Its pages may call its actions: it's running, or waiting to be set up. */
export const pluginRunning = (p: PluginInfo) => p.state === "ready" || p.state === "needs_setup";

/** One of the plugin's own actions, as its pages call them. */
export const pluginAction =
  (id: string) =>
  async <T>(name: string, args: unknown = {}) =>
    (await api<{ result: T }>(`/plugins/${id}/actions/${name}`, { body: args })).result;

export async function loadPlugins() {
  const list = await api<PluginInfo[]>("/plugins");
  set({ plugins: Object.fromEntries(list.map((p) => [p.id, p])) });
  return list.map((p) => p.id);
}

export async function savePlugin(id: string, patch: { enabled?: boolean; config?: unknown }) {
  const p = await api<PluginInfo>(`/plugins/${id}`, { method: "PATCH", body: patch });
  put("plugins", p.id, p);
  return p;
}

/** Each value set on the brain, or null for the host's again; the plugins that read them restart. */
export async function savePluginSecrets(id: string, values: Record<string, string | null>) {
  const p = await api<PluginInfo>(`/plugins/${id}/secrets`, { method: "PUT", body: { values } });
  put("plugins", p.id, p);
  return p;
}

/** The brain starts again to load it; the list comes back when it reconnects. */
export const installPlugin = (url: string, commit: string) =>
  api<{ id: string; name: string }>("/plugins/install", { body: { url, commit } });

export async function uninstallPlugin(id: string, data: boolean) {
  await api(`/plugins/${id}${data ? "?data=1" : ""}`, { method: "DELETE" });
  const { [id]: _, ...rest } = state.plugins;
  set({ plugins: rest });
}

export async function forgetPluginData(id: string) {
  put("plugins", id, await api<PluginInfo>(`/plugins/${id}/forget`, { body: {} }));
}

export const putProposal = (p: Proposal) => put("proposals", p.id, p);
// A page has asked for them, even if none came: a reconnect looks again.
let proposalsLoaded = false;
export async function loadProposals() {
  proposalsLoaded = true;
  const list = await api<Proposal[]>("/proposals?status=pending");
  merge("proposals", list);
}
/** After a reconnect: the latest ones as they are now, and ones answered elsewhere aren't pending. */
async function refreshProposals() {
  const [pending, latest] = await Promise.all([
    api<Proposal[]>("/proposals?status=pending"),
    api<Proposal[]>("/proposals"),
  ]);
  const proposals = Object.fromEntries(
    Object.entries(state.proposals).filter(([, p]) => p.status !== "pending"),
  );
  for (const p of [...latest, ...pending]) proposals[p.id] = p;
  set({ proposals });
}

export const putSchedule = (s: Schedule) => put("schedules", s.id, s);
export const putTrigger = (t: Trigger) => put("triggers", t.id, t);
export const putWatcher = (w: Watcher) => put("watchers", w.id, w);
export async function loadNegotiation(id: number) {
  const d = await api<NegotiationDetail>(`/negotiations/${id}`);
  put("negotiations", id, d.negotiation);
  put("negotiationMessages", id, d.messages);
}
export const ensureNegotiation = (id: number) =>
  once(`n${id}`, !!state.negotiations[id], () => loadNegotiation(id));
export async function loadNegotiations() {
  const list = await api<Negotiation[]>("/negotiations?status=open");
  merge("negotiations", list);
  return list.map((n) => n.id);
}
export const putBox = (b: Box) => put("boxes", b.id, b);
// Boxes has been opened: a reconnect lists them again.
let boxesLoaded = false;
export async function loadBoxes() {
  boxesLoaded = true;
  const known = Object.keys(state.boxes).map(Number);
  const list = await api<Box[]>("/boxes");
  // One we had that isn't listed was deleted while we were away.
  const gone = known.filter((id) => !list.some((b) => b.id === id));
  set({
    boxes: {
      ...state.boxes,
      ...Object.fromEntries(gone.map((id) => [id, null])),
      ...Object.fromEntries(list.map((b) => [b.id, b])),
    },
  });
}
export const ensureBox = (id: number) =>
  once(`x${id}`, id in state.boxes, () =>
    api<Box>(`/boxes/${id}`).then(putBox, (err) => {
      if (!(err instanceof ApiError && err.status === 404)) throw err;
      put("boxes", id, null);
    }),
  );
export const negotiationOf = (s: Pick<State, "negotiations">, approvalId: number) =>
  Object.values(s.negotiations).find((n) => n.approvalId === approvalId);

export const ensureWatcher = (id: number) =>
  once(`w${id}`, id in state.watchers, () =>
    api<Watcher>(`/watchers/${id}`).then(putWatcher, (err) => {
      if (!(err instanceof ApiError && err.status === 404)) throw err;
      put("watchers", id, null);
    }),
  );

/** You trust what the chat wrote for a schedule or watcher: its runs no longer start tainted. */
export async function trustSchedule(id: number) {
  putSchedule(await api<Schedule>(`/schedules/${id}/trust`, { body: {} }));
}
export async function trustWatcher(id: number) {
  putWatcher(await api<Watcher>(`/watchers/${id}/trust`, { body: {} }));
}
/** You trust what a conversation read: its changes no longer ask because of it. */
export async function trustConversation(conversationId: number, episodeId: number) {
  await api(`/conversations/${conversationId}/episodes/${episodeId}/trust`, { body: {} });
}

export async function saveSchedule(id: number, patch: Partial<Schedule> & { at?: string }) {
  const s = await api<Schedule>(`/schedules/${id}`, { method: "PATCH", body: patch });
  putSchedule(s);
  return s;
}

/** What a brain from before the stream's snapshot is asked for instead. */
async function askLive() {
  void loadBots().catch(() => {});
  const [approvals, questions, desktop, unread, computers] = await Promise.all([
    api<Approval[]>("/approvals?pending=1"),
    api<Question[]>("/questions").catch(() => null),
    api<DesktopState>("/desktop/status").catch(() => null),
    api<number[]>("/thread/unread").catch(() => null),
    api<ComputerInfo[]>("/computers").catch(() => []),
  ]);
  return { approvals, questions, desktop, unread, computers };
}

/** What's live as the stream opens: its first event, the snapshot, says, or we ask. */
async function loadLive(snapshot: Snapshot | null) {
  if (snapshot) takeBots(snapshot.bots, snapshot.conversations);
  const [live] = await Promise.all([snapshot ?? askLive(), loadNegotiations().catch(() => null)]);
  const { approvals: pending, questions: asked, desktop, unread, computers = [] } = live;
  if (unread) set({ unread });
  const approvals = { ...state.approvals };
  // Anything we thought pending but the server doesn't list was decided while we were away.
  for (const a of Object.values(approvals))
    if (a.status === "pending") requested.delete(`a${a.id}`);
  for (const a of Object.values(approvals))
    if (
      (a.status === "pending" || a.status === "blocked" || a.status === "sending") &&
      !pending.some((p) => p.id === a.id)
    )
      delete approvals[a.id];
  for (const a of pending) approvals[a.id] = a;
  // Questions answered or dropped while we were away aren't listed.
  if (asked) set({ questions: Object.fromEntries(asked.map((q) => [q.id, q])) });
  set({ approvals, desktop, computers });
  for (const t of Object.values(state.tasks))
    if (state.steps[t.id] && t.finishedAt === null)
      void loadTask(t.id, { since: true }).catch(() => {});
}

export async function decideApproval(
  id: number,
  decision: "approve" | "deny",
  note = "",
  scope?: ApprovalScope,
) {
  const a = await api<Approval>(`/approvals/${id}`, {
    body: { decision, ...(note.trim() ? { note: note.trim() } : {}), ...(scope ? { scope } : {}) },
  });
  put("approvals", a.id, a);
}

/** Runs what the safety review blocked: once, or always for this exact call. */
export async function runAnyway(id: number, always = false) {
  const a = await api<Approval>(`/approvals/${id}/anyway`, { body: always ? { always } : {} });
  put("approvals", a.id, a);
}

export async function dismissBlocked(id: number) {
  await api(`/approvals/${id}/dismiss`, { body: {} });
  const a = state.approvals[id];
  if (a) put("approvals", id, { ...a, status: "cancelled" });
}

export async function answerQuestion(id: number, answer: string) {
  put("questions", id, await api<Question>(`/questions/${id}`, { body: { answer } }));
}

export async function cancelTask(id: number) {
  await api(`/tasks/${id}/cancel`, { body: {} });
}

const putComputer = (c: ComputerInfo) =>
  set({ computers: state.computers.map((x) => (x.id === c.id ? c : x)) });

/** `screen`: one of your computers; the desktop by default. */
export async function takeover(screen: string | null = null) {
  if (screen)
    return putComputer(await api<ComputerInfo>(`/computers/${screen}/takeover`, { body: {} }));
  set({ desktop: await api<DesktopState>("/desktop/takeover", { body: {} }) });
}
export async function handback(screen: string | null = null) {
  if (screen)
    return putComputer(await api<ComputerInfo>(`/computers/${screen}/handback`, { body: {} }));
  set({ desktop: await api<DesktopState>("/desktop/handback", { body: {} }) });
}

const putTeach = (s: TeachSession) => put("teach", s.id, s);

/** Teach is the Desktop plugin's. */
async function loadTeachSessions() {
  if (!pluginOn(state.plugins, "desktop")) return;
  const teach = await api<{ recording: TeachSession | null; drafts: TeachSession[] }>("/teach");
  // A recording that ended while we were away isn't listed any more.
  const sessions = Object.fromEntries(
    Object.entries(state.teach).filter(([, s]) => s.status !== "recording"),
  );
  for (const s of [...teach.drafts, ...(teach.recording ? [teach.recording] : [])])
    sessions[s.id] = s;
  set({ teach: sessions });
}

/** `replaces`: a skill to record again; the draft keeps its name. */
export async function startTeach(replaces?: string) {
  putTeach(await api<TeachSession>("/teach/start", { body: replaces ? { replaces } : {} }));
  // Your input only reaches the desktop once the live view knows you have control.
  set({ desktop: await api<DesktopState>("/desktop/status") });
}
export async function stopTeach() {
  const s = await api<TeachSession>("/teach/stop", { body: {} });
  putTeach(s);
  return s;
}
export async function loadTeach(id: number) {
  putTeach(await api<TeachSession>(`/teach/${id}`));
}
export async function redraftTeach(id: number) {
  putTeach(await api<TeachSession>(`/teach/${id}/draft`, { body: {} }));
}
export async function discardTeach(id: number) {
  putTeach(await api<TeachSession>(`/teach/${id}`, { method: "DELETE" }));
}
export async function saveSkill(
  id: number,
  body: { name: string; content: string; replace?: boolean },
) {
  const r = await api<{ session: TeachSession; path: string }>(`/teach/${id}/save`, { body });
  putTeach(r.session);
  return r.path;
}
export const recording = (s: State) =>
  Object.values(s.teach).find((t) => t.status === "recording") ?? null;

/** Messages you haven't seen: each chat counts them all, the ids are only each chat's newest. */
export const unreadCount = (s: State) =>
  s.conversations.length ? s.conversations.reduce((n, c) => n + c.unread, 0) : s.unread.length;

/** A thread its bot marked as needing you, or one with an approval or a question waiting in it. */
export const threadNeedsYou = (s: State, t: Conversation | undefined) =>
  !!t && needsYouIn(t, [...Object.values(s.approvals), ...Object.values(s.questions)]);

export const needsYou = (s: State) =>
  Object.values(s.approvals).filter((a) => a.status === "pending").length +
  Object.values(s.questions).filter((q) => q.status === "pending").length +
  (s.desktop?.request ? 1 : 0) +
  s.computers.filter((c) => c.request).length;

let toast: Toast = () => {};
export const onToast = (fn: Toast) => {
  toast = fn;
};

/** `fn` over the messages; the same list when it changes none, so nothing re-renders. */
function patchMessages(
  fn: (m: ThreadMessage) => ThreadMessage,
  list = state.messages,
): ThreadMessage[] {
  let changed = false;
  const next = list.map((m) => {
    const n = fn(m);
    if (n !== m) changed = true;
    return n;
  });
  return changed ? next : list;
}

/** What a message event does to the showing chat's messages: the same list when nothing. */
function onMessages(list: ThreadMessage[], e: HatbotEvent, w: Where): ThreadMessage[] {
  const patch = (id: number, fn: (m: ThreadMessage) => ThreadMessage) =>
    patchMessages((m) => (m.id === id ? fn(m) : m), list);
  switch (e.type) {
    case "message.created":
      return !!e.message.incognito === w.incognito && e.message.conversationId === w.conversationId
        ? upsert(list, e.message)
        : list;
    case "message.delta":
      // A page read after this text was sent already has it.
      return patch(e.id, (m) => {
        const text = withDelta(m.text, e);
        return text === m.text ? m : { ...m, text };
      });
    case "message.edited":
      return patch(e.id, (m) => ({ ...m, editedAt: e.editedAt }));
    case "message.rewrite":
      // Its task ended: its bot is writing it again.
      return patch(e.id, (m) => ({ ...m, text: "", status: "streaming" }));
    case "message.seen":
      return patchMessages((m) => (e.ids.includes(m.id) ? { ...m, seenAt: e.seenAt } : m), list);
    case "message.deleted":
      return list.some((m) => e.ids.includes(m.id))
        ? list.filter((m) => !e.ids.includes(m.id))
        : list;
    case "message.attachment":
      return patch(e.id, (m) =>
        m.attachments?.some((a) => a.id === e.attachment.id)
          ? m
          : { ...m, attachments: [...(m.attachments ?? []), e.attachment] },
      );
    case "message.task":
      return patch(e.id, (m) => ({ ...m, taskId: e.taskId }));
    case "message.link":
      return patch(e.id, (m) => ({ ...m, link: e.link }));
    case "message.negotiation":
      return patch(e.id, (m) => ({ ...m, negotiationId: e.negotiationId }));
    case "message.box":
      return patch(e.id, (m) => ({ ...m, boxId: e.boxId }));
    case "message.done":
      return patch(e.id, (m) => ({
        ...m,
        text: e.text,
        status: e.status,
        ...(e.sources ? { sources: e.sources } : {}),
        ...(e.choices ? { choices: e.choices } : {}),
      }));
    default:
      return list;
  }
}

// A reply streams in many small deltas: they're added up and shown once per frame.
const deltas = new Map<number, { text: string; at?: number }>();
let deltaFrame = 0;
function flushDeltas() {
  if (deltaFrame) cancelAnimationFrame(deltaFrame);
  deltaFrame = 0;
  if (!deltas.size) return;
  const added = new Map(deltas);
  deltas.clear();
  const add = (m: ThreadMessage) => {
    const d = added.get(m.id);
    const text = d === undefined ? m.text : withDelta(m.text, d);
    return text === m.text ? m : { ...m, text };
  };
  set(lists((list) => patchMessages(add, list)));
}

/** Both panes' messages through `fn`; a pane whose list is unchanged keeps it, so it doesn't redraw. */
function lists(fn: (list: ThreadMessage[], w: Where) => ThreadMessage[]): Partial<State> {
  const messages = fn(state.messages, mainWhere());
  const side = state.side;
  const w = sideWhere();
  const sideMessages = side && w ? fn(side.messages, w) : null;
  return {
    messages,
    ...(side && sideMessages && sideMessages !== side.messages
      ? { side: { ...side, messages: sideMessages } }
      : {}),
  };
}
const onLists = (e: HatbotEvent) => lists((list, w) => onMessages(list, e, w));

function apply(e: HatbotEvent) {
  if (e.type.startsWith("message.")) for (const events of missed) events.push(e);
  if (e.type === "message.delta") {
    const d = deltas.get(e.id);
    deltas.set(e.id, d ? { ...d, text: d.text + e.text } : { text: e.text, at: e.at });
    if (!deltaFrame) deltaFrame = requestAnimationFrame(flushDeltas);
    return;
  }
  // Everything else lands after the deltas that came before it.
  flushDeltas();
  switch (e.type) {
    case "settings.updated":
      return set({ settingsVersion: state.settingsVersion + 1 });
    case "heartbeat.updated":
      return set({ heartbeatVersion: state.heartbeatVersion + 1 });
    case "message.created":
      if (e.message.incognito) incognitoIds.add(e.message.id);
      if (e.message.role === "assistant") refreshConversations();
      return set({
        ...onLists(e),
        unread:
          // What came of your own command arrives already seen.
          e.message.role === "assistant" && e.message.status !== "streaming" && !e.message.seenAt
            ? addUnread(e.message.id)
            : state.unread,
      });
    case "message.edited":
      refreshConversations();
      return set({ ...onLists(e), unread: addUnread(e.id) });
    case "message.seen":
    case "message.deleted":
      refreshConversations();
      return set({
        ...onLists(e),
        unread: state.unread.filter((id) => !e.ids.includes(id)),
      });
    case "message.progress": {
      const text = keepLines((state.progress[e.id] ?? "") + e.text);
      return put("progress", e.id, text);
    }
    case "message.rewrite":
    case "message.attachment":
    case "message.task":
    case "message.link":
    case "message.negotiation":
    case "message.box":
      return set(onLists(e));
    case "message.usage":
      return put("usage", e.id, { tokens: e.tokens, costUsd: e.costUsd });
    case "message.done": {
      const { [e.id]: _, ...progress } = state.progress;
      const { [e.id]: __, ...usage } = state.usage;
      refreshConversations();
      return set({
        progress,
        usage,
        unread: addUnread(e.id),
        ...onLists(e),
      });
    }
    case "spend.updated":
      return set({ todayUsd: e.todayUsd, monthUsd: e.monthUsd });
    case "proposal.updated":
      return putProposal(e.proposal);
    case "memory.committed":
      if (state.botIds.some((id) => botName(state, id) === e.author))
        toast(`Memory: ${e.message}`, "info");
      return set({ memoryVersion: state.memoryVersion + 1 });
    case "snapshot":
    case "paused":
      return set({ paused: e.paused });
    case "task.updated": {
      const { [e.task.id]: _, ...taskProgress } = state.taskProgress;
      return set({
        tasks: { ...state.tasks, [e.task.id]: e.task },
        taskProgress: e.task.status === "running" ? state.taskProgress : taskProgress,
      });
    }
    case "task.step": {
      const list = state.steps[e.step.taskId];
      if (!list) return;
      const steps = list.some((x) => x.id === e.step.id)
        ? list.map((x) => (x.id === e.step.id ? e.step : x))
        : [...list, e.step];
      return put("steps", e.step.taskId, steps);
    }
    case "task.progress": {
      const text = keepLines((state.taskProgress[e.taskId] ?? "") + e.text);
      return put("taskProgress", e.taskId, text);
    }
    case "approval.created":
    case "approval.resolved":
      return put("approvals", e.approval.id, e.approval);
    case "question.created":
    case "question.resolved":
      return put("questions", e.question.id, e.question);
    case "desktop.state":
      return set({ desktop: e.state });
    case "computers":
      return set({ computers: e.computers });
    case "schedule.updated":
      return putSchedule(e.schedule);
    case "schedule.deleted":
      return put("schedules", e.id, null);
    case "trigger.updated":
      return putTrigger(e.trigger);
    case "trigger.deleted":
      return put("triggers", e.id, null);
    case "watcher.updated":
      return putWatcher(e.watcher);
    case "watcher.deleted":
      return put("watchers", e.id, null);
    case "negotiation.updated":
      // An open page shows every message, which the event doesn't carry.
      if (state.negotiationMessages[e.negotiation.id])
        void loadNegotiation(e.negotiation.id).catch(() => {});
      return put("negotiations", e.negotiation.id, e.negotiation);
    case "box.updated":
      return putBox(e.box);
    case "box.deleted":
      return put("boxes", e.id, null);
    case "plugin.updated":
      return put("plugins", e.plugin.id, e.plugin);
    case "teach.updated":
      return putTeach(e.session);
    case "episode.updated":
      return put("episodes", e.episode.id, e.episode);
    case "bot.updated":
      return putBot(e.bot);
    case "bot.deleted":
      refreshConversations();
      return set({ botIds: state.botIds.filter((id) => id !== e.id) });
    case "conversation.updated":
      return putConversation(e.conversation);
    case "conversation.deleted":
      return set({ conversations: state.conversations.filter((c) => c.id !== e.id) });
  }
}

/**
 * A time the loaded messages were all current at, in the brain's clock: your bots' messages come only
 * while the stream is up, and their times and edits are no later than when it went down. Yours may have
 * been posted after.
 */
function currentAt(list: ThreadMessage[]): string | undefined {
  const times = list
    .filter((m) => m.role === "assistant")
    .map((m) => (m.editedAt && m.editedAt > m.createdAt ? m.editedAt : m.createdAt))
    .sort();
  return times.at(-1) ?? list[0]?.createdAt;
}

/** The latest page again, merged into what's loaded: earlier pages stay, so the view doesn't jump. */
async function refreshThread(side = false) {
  const w = whereOf(side);
  if (!w) return;
  const since = currentAt(listOf(side));
  const { list: latest, events } = await messagesPage(w);
  if (!sameWhere(w, whereOf(side))) return;
  flushDeltas();
  const first = latest[0];
  const last = listOf(side).at(-1);
  // The whole conversation, or a full page past everything loaded (a gap): it starts again from here.
  if (!first || latest.length < PAGE || !last || last.id < first.id)
    return setList(side, caughtUp(latest, events, w), latest.length === PAGE);
  const older = listOf(side).filter((m) => m.id < first.id);
  setList(side, [...older, ...caughtUp(latest, events, w)]);
  const from = older[0]?.id;
  if (from === undefined || !since) return;
  await refreshEarlier(side, from, first.id, since).catch((err) => {
    // Not known to be current, and the next load couldn't tell since when: they load again.
    if (err instanceof ApiError && err.status === 404) return;
    if (!sameWhere(w, whereOf(side))) return;
    setList(
      side,
      listOf(side).filter((m) => m.id >= first.id),
      true,
    );
  });
}

/**
 * Earlier pages brought up to date without loading them again: what was deleted meanwhile goes, and
 * what a task's result edited is replaced.
 */
async function refreshEarlier(side: boolean, from: number, before: number, since: string) {
  const w = whereOf(side);
  if (!w) return;
  const events: HatbotEvent[] = [];
  missed.add(events);
  try {
    const { ids, changed } = await api<MessageChanges>(
      `/conversations/${w.conversationId}/messages/changes?from=${from}&before=${before}&since=${encodeURIComponent(since)}${w.incognito ? "&incognito=1" : ""}`,
    );
    if (!sameWhere(w, whereOf(side))) return;
    const kept = new Set(ids);
    const fresh = new Map(changed.map((m) => [m.id, m]));
    const inRange = (m: ThreadMessage) => m.id >= from && m.id < before;
    const list = listOf(side);
    const range = list.filter((m) => inRange(m) && kept.has(m.id)).map((m) => fresh.get(m.id) ?? m);
    // What came meanwhile goes on again, onto these only: the rest has it already.
    const caught = caughtUp(range, events, w).filter(inRange);
    setList(side, [
      ...list.filter((m) => m.id < from),
      ...caught,
      ...list.filter((m) => m.id >= before),
    ]);
  } finally {
    missed.delete(events);
  }
}

/**
 * What may have changed while the stream was down, or, on the first open, between the first loads and
 * the stream's start. `reconnected`: pages showing settings, memory or the heartbeat load them again.
 */
async function catchUp(reconnected: boolean) {
  // Which views show: those of plugins that are off don't.
  void loadPlugins()
    .then(loadTeachSessions)
    .catch(() => {});
  // The chats come with loadLive's bots.
  if (reconnected || threadShown) void refreshThread().catch(() => {});
  if (state.side) void refreshThread(true).catch(() => {});
  void api<SpendSummary>("/spend/summary").then(
    (s) => set({ todayUsd: s.todayUsd, monthUsd: s.monthUsd }),
    () => {},
  );
  if (
    Object.keys(state.schedules).length ||
    Object.keys(state.triggers).length ||
    Object.keys(state.watchers).length
  )
    void loadSchedules().catch(() => {});
  // A card in the chat whose one fetch failed tries again.
  for (const m of [...state.messages, ...(state.side?.messages ?? [])]) {
    if (m.taskId) ensureTask(m.taskId);
    if (m.scheduleId) ensureSchedule(m.scheduleId);
    if (m.negotiationId) ensureNegotiation(m.negotiationId);
    if (m.boxId) ensureBox(m.boxId);
  }
  if (reconnected) {
    set({
      settingsVersion: state.settingsVersion + 1,
      heartbeatVersion: state.heartbeatVersion + 1,
      memoryVersion: state.memoryVersion + 1,
    });
    if (proposalsLoaded || Object.keys(state.proposals).length)
      void refreshProposals().catch(() => {});
    if (boxesLoaded) void loadBoxes().catch(() => {});
    for (const parent of new Set(Object.values(state.threads).map((t) => t.parentId)))
      if (parent !== null) void loadThreads(parent).catch(() => {});
    // A negotiation's page shows its messages; negotiation.updated may have been missed.
    for (const id of Object.keys(state.negotiationMessages))
      void loadNegotiation(Number(id)).catch(() => {});
  }
  const active = await loadTasks({ status: "active" }).catch(() => null);
  // Ones we thought running that aren't any more ended while we were away. loadLive reloads those
  // with steps.
  const ended = Object.values(state.tasks)
    .filter((t) => t.finishedAt === null && !active?.includes(t.id) && !state.steps[t.id])
    .map((t) => t.id);
  if (active && ended.length) void loadTasks({ ids: ended, view: "card" }).catch(() => {});
}

export const openSocket = (path: string) =>
  new WebSocket(`${location.origin.replace(/^http/, "ws")}${API_PREFIX}${path}`);

let socket: WebSocket | null = null;
let retry = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let stopped = false;
let opened = false;
let listening = false;

export function connect() {
  stopped = false;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  if (!listening) {
    listening = true;
    // Back online or back in front: try at once rather than at the next backoff.
    const wake = () => {
      if (document.visibilityState === "visible") reconnectNow();
    };
    window.addEventListener("online", wake);
    window.addEventListener("focus", wake);
    document.addEventListener("visibilitychange", wake);
  }
  const ws = openSocket("/stream");
  socket = ws;
  let wasOpen = false;
  // A socket that's been replaced (StrictMode opens two) says nothing more.
  ws.onopen = () => {
    if (ws !== socket) return;
    wasOpen = true;
    void catchUp(opened);
    opened = true;
    retry = 0;
    set({ connected: true });
  };
  let first = true;
  ws.onmessage = (ev) => {
    if (ws !== socket) return;
    const e = JSON.parse(ev.data) as HatbotEvent;
    if (first) {
      first = false;
      void loadLive(e.type === "snapshot" ? e : null).catch(() => {});
    }
    apply(e);
  };
  ws.onclose = () => {
    if (ws !== socket) return;
    socket = null;
    set({ connected: false });
    if (stopped) return;
    // A refused socket looks the same whether the brain is down or you're signed out; ask which.
    if (!wasOpen) void checkSignedIn();
    retryTimer = setTimeout(connect, Math.min(30_000, 1000 * 2 ** retry++));
  };
}

async function checkSignedIn() {
  const me = await api<Me>("/auth/me").catch(() => null);
  if (me && !me.authenticated) window.dispatchEvent(new Event("hatbot:unauthorized"));
}

export function reconnectNow() {
  if (stopped || socket) return;
  retry = 0;
  connect();
}

export function disconnect() {
  stopped = true;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  const ws = socket;
  socket = null;
  ws?.close();
  if (state.connected) set({ connected: false });
}
