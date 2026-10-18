// Live client state: the thread, tasks, approvals, the desktop, pause state and spend, fed by the WebSocket.
import {
  API_PREFIX,
  type Approval,
  type Bot,
  type Conversation,
  type DesktopState,
  type Episode,
  type HatbotEvent,
  type Me,
  type Negotiation,
  type NegotiationDetail,
  type NegotiationMessage,
  type PluginInfo,
  type Proposal,
  type Schedule,
  type SpendSummary,
  type Task,
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

type State = {
  /** The chat that's showing: a bot's own, or a group. */
  conversationId: number;
  /** The incognito conversation is showing instead of the chat. */
  incognito: boolean;
  messages: ThreadMessage[];
  /** The conversations the loaded messages belong to, for their recaps. */
  episodes: Record<number, Episode>;
  /** Latest progress note per streaming message. */
  progress: Record<number, string>;
  /** What each streaming reply has used so far. */
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
  tasks: Record<number, Task>;
  /** Steps of the tasks that have been opened or shown as a card. */
  steps: Record<number, TaskStep[]>;
  /** Latest progress note per running task. */
  taskProgress: Record<number, string>;
  approvals: Record<number, Approval>;
  desktop: DesktopState | null;
  /** null: deleted, or never existed. */
  schedules: Record<number, Schedule | null>;
  triggers: Record<number, Trigger | null>;
  watchers: Record<number, Watcher | null>;
  /** Negotiations with sellers (PLAN.md §16): the open ones, and any a chat or page has shown. */
  negotiations: Record<number, Negotiation>;
  /** The messages of negotiations whose page has been opened. */
  negotiationMessages: Record<number, NegotiationMessage[]>;
  plugins: Record<string, PluginInfo>;
  /** Memory changes waiting for you, and ones you've answered this session. */
  proposals: Record<number, Proposal>;
  /** Teach-by-showing: the recording in progress and drafts, by id. */
  teach: Record<number, TeachSession>;
  /** Your bots, deleted ones too once seen: old messages still name them. */
  bots: Record<string, Bot>;
  /** Bots that aren't deleted, Hatbot first. */
  botIds: string[];
  /** Your chats: each bot's own, then groups. */
  conversations: Conversation[];
};

/** Hatbot's own chat: the first one, made with the database. */
export const HATBOT_CHAT = 1;
/** A chat's address. Hatbot's chat is the app's front page. */
export const chatPath = (id: number) => (id === HATBOT_CHAT ? "/" : `/chat/${id}`);

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
  taskProgress: {},
  approvals: {},
  desktop: null,
  schedules: {},
  triggers: {},
  watchers: {},
  negotiations: {},
  negotiationMessages: {},
  plugins: {},
  proposals: {},
  teach: {},
  bots: {},
  botIds: [],
  conversations: [],
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

/** The parts of the state that are maps by id. */
type MapKey = {
  [K in keyof State]: State[K] extends unknown[]
    ? never
    : State[K] extends Record<number, unknown>
      ? K
      : never;
}[keyof State];
type Id<K extends MapKey> = keyof State[K];
type Entry<K extends MapKey> = State[K][Id<K>];

/** Sets one entry of a map. */
function put<K extends MapKey>(key: K, id: Id<K>, v: Entry<K>) {
  set({ [key]: { ...state[key], [id]: v } });
}
/** Adds or replaces each of `list` in a map, by its id. */
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

/** Fetches the conversations of `messages` we don't have yet. */
async function loadEpisodes(messages: ThreadMessage[]) {
  const ids = [...new Set(messages.map((m) => m.episodeId))].filter(
    (id): id is number => id !== null && !state.episodes[id],
  );
  if (!ids.length) return;
  const list = await api<Episode[]>(
    `/conversations/${state.conversationId}/episodes?ids=${ids.join(",")}`,
  );
  merge("episodes", list);
}

const page = (before?: number) =>
  `/conversations/${state.conversationId}/messages?limit=${PAGE}${before ? `&before=${before}` : ""}${state.incognito ? "&incognito=1" : ""}`;

// Message events that come while a page of messages loads: the page was read before them, so they're
// put onto it again, or a reply that finished meanwhile would stay streaming.
const missed = new Set<HatbotEvent[]>();

/** A page of the showing chat's messages, and the message events that came while it loaded. */
async function messagesPage(before?: number) {
  const events: HatbotEvent[] = [];
  missed.add(events);
  try {
    const list = await api<ThreadMessage[]>(page(before));
    await loadEpisodes(list).catch(() => {});
    return { list, events };
  } finally {
    missed.delete(events);
  }
}

/** A page with the events that came while it loaded. Deltas still waiting for a frame are among them. */
function caughtUp(list: ThreadMessage[], events: HatbotEvent[]) {
  flushDeltas();
  return events.reduce(onMessages, list);
}

/** A chat has been shown: the stream's first open catches its thread up too. */
let threadShown = false;

export async function loadThread() {
  threadShown = true;
  const { incognito, conversationId } = state;
  const { list, events } = await messagesPage();
  // Switched while it loaded: the other conversation's load wins.
  if (incognito !== state.incognito || conversationId !== state.conversationId) return;
  set({ messages: caughtUp(list, events), hasEarlier: list.length === PAGE });
}

let earlier: Promise<void> | null = null;
/** The page before the first message showing. Asked for again while it loads, it's the same load. */
export function loadEarlier(): Promise<void> {
  earlier ??= (async () => {
    const first = state.messages[0];
    if (!first) return;
    const { incognito, conversationId } = state;
    const { list, events } = await messagesPage(first.id);
    // Switched, to incognito too, or loaded again from the bottom: it doesn't go on the top any more.
    if (
      incognito !== state.incognito ||
      conversationId !== state.conversationId ||
      state.messages[0]?.id !== first.id
    )
      return;
    const have = new Set(state.messages.map((m) => m.id));
    const older = caughtUp(list, events).filter((m) => !have.has(m.id));
    set({ messages: [...older, ...state.messages], hasEarlier: list.length === PAGE });
  })().finally(() => {
    earlier = null;
  });
  return earlier;
}

/**
 * Posts your message. `clientId` is the send's own id: sent again with it after the answer was lost,
 * the brain posts it once.
 */
export async function sendMessage(text: string, attachmentIds: number[] = [], clientId?: string) {
  const m = await api<ThreadMessage>(`/conversations/${state.conversationId}/messages`, {
    body: { text, attachmentIds, incognito: state.incognito, clientId },
    timeout: 30_000,
  });
  if (!!m.incognito === state.incognito && m.conversationId === state.conversationId)
    set({ messages: upsert(state.messages, m) });
}

/** Has an errored reply written again; it's rewritten in place, through the usual events. */
export async function retryReply(m: ThreadMessage) {
  await api(`/conversations/${m.conversationId}/messages/${m.id}/retry`, { body: {} });
}

/** Deletes a conversation from the chat for good; message.deleted takes it off the screen. */
export async function deleteEpisode(id: number) {
  await api(`/conversations/${state.conversationId}/episodes/${id}`, { method: "DELETE" });
}

/** Into incognito, or out of it, which deletes its conversation. */
export async function setIncognito(on: boolean) {
  if (on === state.incognito) return;
  if (on) sessionStorage.setItem(INCOGNITO_KEY, String(state.conversationId));
  else sessionStorage.removeItem(INCOGNITO_KEY);
  set({ incognito: on, messages: [], hasEarlier: false });
  // The chat loads the conversation it switched to.
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
    api<Bot[]>("/bots"),
    api<Conversation[]>("/conversations"),
  ]);
  merge("bots", bots);
  set({ botIds: bots.map((b) => b.id), conversations });
}

let refreshing: ReturnType<typeof setTimeout> | null = null;
/** The chats' unread counts and order, soon: news comes in bursts. */
function refreshConversations() {
  if (refreshing) return;
  refreshing = setTimeout(() => {
    refreshing = null;
    api<Conversation[]>("/conversations").then(
      (conversations) => set({ conversations }),
      () => {},
    );
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
/** A group chat of `botIds` and you. */
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
  set({
    conversations: state.conversations.some((x) => x.id === c.id)
      ? state.conversations.map((x) => (x.id === c.id ? c : x))
      : [...state.conversations, c],
  });
const putBot = (b: Bot) => {
  put("bots", b.id, b);
  if (!state.botIds.includes(b.id)) set({ botIds: [...state.botIds, b.id] });
};

/** A bot's name; the id for one we don't know. */
export const botName = (s: State, id: string | null | undefined) =>
  id ? (s.bots[id]?.name ?? id) : "";
/** A chat's name: a group's title, or its bot's name. */
export const chatName = (s: State, c: Conversation | undefined) =>
  !c
    ? "Chat"
    : c.kind === "group"
      ? c.title || c.botIds.map((id) => botName(s, id)).join(", ")
      : botName(s, c.botIds[0]);
export const currentChat = (s: State) => s.conversations.find((c) => c.id === s.conversationId);

/** Messages in an incognito conversation: they're never unread. */
const incognitoIds = new Set<number>();
const addUnread = (id: number) =>
  state.unread.includes(id) || incognitoIds.has(id)
    ? state.unread
    : [...state.unread, id].sort((a, b) => a - b);

/** You've seen these messages: they stop counting as unread here and on your other devices. */
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

export async function loadTask(id: number) {
  const { task, steps } = await api<{ task: Task; steps: TaskStep[] }>(`/tasks/${id}`);
  put("tasks", id, task);
  put("steps", id, steps);
}

const requested = new Set<string>();
/** Runs `load` once for `key`, unless `have`; after a failure, the next ask runs it again. */
function once(key: string, have: boolean, load: () => Promise<unknown>) {
  if (have || requested.has(key)) return;
  requested.add(key);
  load().catch(() => requested.delete(key));
}
let wanted: number[] = [];
/** Loads a task the first time something shows it. A chat's task cards come in one request. */
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
    loadTasks({ ids: some }).catch(() => {
      for (const id of some) requested.delete(`t${id}`);
    });
  }
}
/** A task with its steps, for the live view. */
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
    /** Just these, whatever their age. */
    ids?: number[];
  } = {},
) {
  const q = new URLSearchParams(
    Object.entries(filter).flatMap(([k, v]) => (v === undefined ? [] : [[k, String(v)]])),
  ).toString();
  const list = await api<Task[]>(`/tasks${q ? `?${q}` : ""}`);
  merge("tasks", list);
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
/** A negotiation with its messages, for its page. */
export async function loadNegotiation(id: number) {
  const d = await api<NegotiationDetail>(`/negotiations/${id}`);
  put("negotiations", id, d.negotiation);
  put("negotiationMessages", id, d.messages);
}
/** Loads a negotiation the first time a chat shows it. */
export const ensureNegotiation = (id: number) =>
  once(`n${id}`, !!state.negotiations[id], () => loadNegotiation(id));
/** The open negotiations: the Tasks page lists them. */
export async function loadNegotiations() {
  const list = await api<Negotiation[]>("/negotiations?status=open");
  merge("negotiations", list);
  return list.map((n) => n.id);
}
/** The negotiation a mandate approval is for. */
export const negotiationOf = (s: Pick<State, "negotiations">, approvalId: number) =>
  Object.values(s.negotiations).find((n) => n.approvalId === approvalId);

export async function saveSchedule(id: number, patch: Partial<Schedule> & { at?: string }) {
  const s = await api<Schedule>(`/schedules/${id}`, { method: "PATCH", body: patch });
  putSchedule(s);
  return s;
}

async function loadLive() {
  void loadBots().catch(() => {});
  const [pending, desktop, teach, unread] = await Promise.all([
    api<Approval[]>("/approvals?pending=1"),
    api<DesktopState>("/desktop/status").catch(() => null),
    api<{ recording: TeachSession | null; drafts: TeachSession[] }>("/teach").catch(() => null),
    api<number[]>("/thread/unread").catch(() => null),
    // Mandate approvals link to their negotiations.
    loadNegotiations().catch(() => null),
  ]);
  if (unread) set({ unread });
  const approvals = { ...state.approvals };
  // Anything we thought pending but the server doesn't list was decided while we were away.
  for (const a of Object.values(approvals))
    if (a.status === "pending") requested.delete(`a${a.id}`);
  for (const a of Object.values(approvals))
    if (a.status === "pending" && !pending.some((p) => p.id === a.id)) delete approvals[a.id];
  for (const a of pending) approvals[a.id] = a;
  set({ approvals, desktop });
  if (teach) {
    // A recording that ended while we were away isn't listed any more.
    const sessions = Object.fromEntries(
      Object.entries(state.teach).filter(([, s]) => s.status !== "recording"),
    );
    for (const s of [...teach.drafts, ...(teach.recording ? [teach.recording] : [])])
      sessions[s.id] = s;
    set({ teach: sessions });
  }
  for (const t of Object.values(state.tasks))
    if (state.steps[t.id] && t.finishedAt === null) void loadTask(t.id).catch(() => {});
}

export async function decideApproval(id: number, decision: "approve" | "deny", note = "") {
  const a = await api<Approval>(`/approvals/${id}`, {
    body: { decision, ...(note.trim() ? { note: note.trim() } : {}) },
  });
  put("approvals", a.id, a);
}

export async function cancelTask(id: number) {
  await api(`/tasks/${id}/cancel`, { body: {} });
}

export async function takeover() {
  set({ desktop: await api<DesktopState>("/desktop/takeover", { body: {} }) });
}
export async function handback() {
  set({ desktop: await api<DesktopState>("/desktop/handback", { body: {} }) });
}

const putTeach = (s: TeachSession) => put("teach", s.id, s);

/** Takes the desktop for you and starts recording. */
/** `replaces`: a skill to record again; the draft keeps its name. */
export async function startTeach(replaces?: string) {
  putTeach(await api<TeachSession>("/teach/start", { body: replaces ? { replaces } : {} }));
  // Your input only reaches the desktop once the live view knows you have control.
  set({ desktop: await api<DesktopState>("/desktop/status") });
}
/** Stops recording; the skill is drafted next. */
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

/** Approvals waiting for you, plus a takeover request. */
export const needsYou = (s: State) =>
  Object.values(s.approvals).filter((a) => a.status === "pending").length +
  (s.desktop?.request ? 1 : 0);

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
function onMessages(list: ThreadMessage[], e: HatbotEvent): ThreadMessage[] {
  const patch = (id: number, fn: (m: ThreadMessage) => ThreadMessage) =>
    patchMessages((m) => (m.id === id ? fn(m) : m), list);
  switch (e.type) {
    case "message.created":
      // Only the conversation that's showing.
      return !!e.message.incognito === state.incognito &&
        e.message.conversationId === state.conversationId
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
    case "message.negotiation":
      return patch(e.id, (m) => ({ ...m, negotiationId: e.negotiationId }));
    case "message.done":
      return patch(e.id, (m) => ({
        ...m,
        text: e.text,
        status: e.status,
        ...(e.sources ? { sources: e.sources } : {}),
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
  const messages = patchMessages((m) => {
    const d = added.get(m.id);
    const text = d === undefined ? m.text : withDelta(m.text, d);
    return text === m.text ? m : { ...m, text };
  });
  if (messages !== state.messages) set({ messages });
}

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
        messages: onMessages(state.messages, e),
        unread:
          // What came of your own command arrives already seen.
          e.message.role === "assistant" && e.message.status !== "streaming" && !e.message.seenAt
            ? addUnread(e.message.id)
            : state.unread,
      });
    case "message.edited":
      refreshConversations();
      return set({ messages: onMessages(state.messages, e), unread: addUnread(e.id) });
    case "message.seen":
    case "message.deleted":
      refreshConversations();
      return set({
        messages: onMessages(state.messages, e),
        unread: state.unread.filter((id) => !e.ids.includes(id)),
      });
    case "message.progress": {
      const text = ((state.progress[e.id] ?? "") + e.text).slice(-400);
      return put("progress", e.id, text);
    }
    case "message.rewrite":
    case "message.attachment":
    case "message.task":
    case "message.negotiation":
      return set({ messages: onMessages(state.messages, e) });
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
        messages: onMessages(state.messages, e),
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
      const text = ((state.taskProgress[e.taskId] ?? "") + e.text).slice(-400);
      return put("taskProgress", e.taskId, text);
    }
    case "approval.created":
    case "approval.resolved":
      return put("approvals", e.approval.id, e.approval);
    case "desktop.state":
      return set({ desktop: e.state });
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

/** The latest page again, merged into what's loaded: earlier pages stay, so the view doesn't jump. */
async function refreshThread() {
  const { incognito, conversationId } = state;
  const { list: latest, events } = await messagesPage();
  if (incognito !== state.incognito || conversationId !== state.conversationId) return;
  flushDeltas();
  const first = latest[0];
  const last = state.messages.at(-1);
  // The whole conversation, or a full page past everything loaded (a gap): it starts again from here.
  if (!first || latest.length < PAGE || !last || last.id < first.id)
    return set({ messages: caughtUp(latest, events), hasEarlier: latest.length === PAGE });
  const older = state.messages.filter((m) => m.id < first.id);
  set({ messages: [...older, ...caughtUp(latest, events)] });
}

/**
 * What may have changed while the stream was down, or, on the first open, between the first loads and
 * the stream's start. `reconnected`: pages showing settings, memory or the heartbeat load them again.
 */
async function catchUp(reconnected: boolean) {
  // The chats come with loadLive's bots.
  if (reconnected || threadShown) void refreshThread().catch(() => {});
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
  for (const m of state.messages) {
    if (m.taskId) ensureTask(m.taskId);
    if (m.scheduleId) ensureSchedule(m.scheduleId);
    if (m.negotiationId) ensureNegotiation(m.negotiationId);
  }
  if (reconnected) {
    set({
      settingsVersion: state.settingsVersion + 1,
      heartbeatVersion: state.heartbeatVersion + 1,
      memoryVersion: state.memoryVersion + 1,
    });
    if (proposalsLoaded || Object.keys(state.proposals).length)
      void refreshProposals().catch(() => {});
    if (Object.keys(state.plugins).length) void loadPlugins().catch(() => {});
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
  if (active && ended.length) void loadTasks({ ids: ended }).catch(() => {});
}

/** One of the brain's WebSockets, by its path: wss: on an https: page. */
export const openSocket = (path: string) =>
  new WebSocket(`${location.origin.replace(/^http/, "ws")}${API_PREFIX}${path}`);

let socket: WebSocket | null = null;
let retry = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let stopped = false;
let opened = false;
let listening = false;

/** Opens the event stream and keeps it open, catching up after a reconnect. */
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
    void loadLive().catch(() => {});
    retry = 0;
    set({ connected: true });
  };
  ws.onmessage = (ev) => {
    if (ws === socket) apply(JSON.parse(ev.data) as HatbotEvent);
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

/** Reconnects now if the stream is down and waiting to try again. */
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
