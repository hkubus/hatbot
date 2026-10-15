// Live client state: the thread, tasks, approvals, the desktop, pause state and spend, fed by the WebSocket.
import {
  API_PREFIX,
  type Approval,
  type Bot,
  type Conversation,
  type DesktopState,
  type Episode,
  type HatbotEvent,
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

const INCOGNITO_KEY = "hatbot:incognito";

let state: State = {
  conversationId: HATBOT_CHAT,
  incognito: sessionStorage.getItem(INCOGNITO_KEY) === "1",
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

export function useStore<T>(select: (s: State) => T): T {
  return useSyncExternalStore(subscribe, () => select(state));
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
  set({ episodes: { ...state.episodes, ...Object.fromEntries(list.map((e) => [e.id, e])) } });
}

const page = (before?: number) =>
  `/conversations/${state.conversationId}/messages?limit=${PAGE}${before ? `&before=${before}` : ""}${state.incognito ? "&incognito=1" : ""}`;

export async function loadThread() {
  const { incognito, conversationId } = state;
  const messages = await api<ThreadMessage[]>(page());
  await loadEpisodes(messages).catch(() => {});
  // Switched while it loaded: the other conversation's load wins.
  if (incognito !== state.incognito || conversationId !== state.conversationId) return;
  set({ messages, hasEarlier: messages.length === PAGE });
}

export async function loadEarlier() {
  const first = state.messages[0];
  if (!first) return;
  const { conversationId } = state;
  const older = await api<ThreadMessage[]>(page(first.id));
  await loadEpisodes(older).catch(() => {});
  if (conversationId !== state.conversationId) return;
  set({ messages: [...older, ...state.messages], hasEarlier: older.length === PAGE });
}

export async function sendMessage(text: string, attachmentIds: number[] = []) {
  const m = await api<ThreadMessage>(`/conversations/${state.conversationId}/messages`, {
    body: { text, attachmentIds, incognito: state.incognito },
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
  if (on) sessionStorage.setItem(INCOGNITO_KEY, "1");
  else sessionStorage.removeItem(INCOGNITO_KEY);
  set({ incognito: on, messages: [], hasEarlier: false });
  // The chat loads the conversation it switched to.
  if (!on)
    await api(`/conversations/${state.conversationId}/incognito`, { method: "DELETE" }).catch(
      () => {},
    );
}

/** Shows another chat. Leaving one in incognito deletes its conversation. */
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
  set({
    bots: { ...state.bots, ...Object.fromEntries(bots.map((b) => [b.id, b])) },
    botIds: bots.map((b) => b.id),
    conversations,
  });
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
const putBot = (b: Bot) =>
  set({
    bots: { ...state.bots, [b.id]: b },
    botIds: state.botIds.includes(b.id) ? state.botIds : [...state.botIds, b.id],
  });

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
  set({ tasks: { ...state.tasks, [id]: task }, steps: { ...state.steps, [id]: steps } });
}

const requested = new Set<string>();
/** Loads a task or approval the first time something shows it. */
export function ensureTask(id: number) {
  if (state.tasks[id] && state.steps[id]) return;
  if (requested.has(`t${id}`)) return;
  requested.add(`t${id}`);
  loadTask(id).catch(() => requested.delete(`t${id}`));
}
export function ensureApproval(id: number) {
  if (state.approvals[id] || requested.has(`a${id}`)) return;
  requested.add(`a${id}`);
  api<Approval>(`/approvals/${id}`).then(
    (a) => set({ approvals: { ...state.approvals, [a.id]: a } }),
    () => requested.delete(`a${id}`),
  );
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
  } = {},
) {
  const q = new URLSearchParams(
    Object.entries(filter).flatMap(([k, v]) => (v === undefined ? [] : [[k, String(v)]])),
  ).toString();
  const list = await api<Task[]>(`/tasks${q ? `?${q}` : ""}`);
  const tasks = { ...state.tasks };
  for (const t of list) tasks[t.id] = t;
  set({ tasks });
  return list.map((t) => t.id);
}

export async function loadSchedules() {
  const [schedules, triggers, watchers] = await Promise.all([
    api<Schedule[]>("/schedules"),
    api<Trigger[]>("/triggers"),
    api<Watcher[]>("/watchers"),
  ]);
  set({
    schedules: { ...state.schedules, ...Object.fromEntries(schedules.map((s) => [s.id, s])) },
    triggers: { ...state.triggers, ...Object.fromEntries(triggers.map((t) => [t.id, t])) },
    watchers: { ...state.watchers, ...Object.fromEntries(watchers.map((w) => [w.id, w])) },
  });
  return {
    schedules: schedules.map((s) => s.id),
    triggers: triggers.map((t) => t.id),
    watchers: watchers.map((w) => w.id),
  };
}

export function ensureSchedule(id: number) {
  if (id in state.schedules || requested.has(`s${id}`)) return;
  requested.add(`s${id}`);
  api<Schedule>(`/schedules/${id}`).then(
    (s) => putSchedule(s),
    (err) => {
      if (err instanceof ApiError && err.status === 404)
        set({ schedules: { ...state.schedules, [id]: null } });
      else requested.delete(`s${id}`);
    },
  );
}

export async function loadPlugins() {
  const list = await api<PluginInfo[]>("/plugins");
  set({ plugins: Object.fromEntries(list.map((p) => [p.id, p])) });
  return list.map((p) => p.id);
}

export async function savePlugin(id: string, patch: { enabled?: boolean; config?: unknown }) {
  const p = await api<PluginInfo>(`/plugins/${id}`, { method: "PATCH", body: patch });
  set({ plugins: { ...state.plugins, [p.id]: p } });
  return p;
}

export const putProposal = (p: Proposal) => set({ proposals: { ...state.proposals, [p.id]: p } });
export async function loadProposals() {
  const list = await api<Proposal[]>("/proposals?status=pending");
  set({ proposals: { ...state.proposals, ...Object.fromEntries(list.map((p) => [p.id, p])) } });
}

export const putSchedule = (s: Schedule) => set({ schedules: { ...state.schedules, [s.id]: s } });
export const putTrigger = (t: Trigger) => set({ triggers: { ...state.triggers, [t.id]: t } });
export const putWatcher = (w: Watcher) => set({ watchers: { ...state.watchers, [w.id]: w } });

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
  set({ approvals: { ...state.approvals, [a.id]: a } });
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

const putTeach = (s: TeachSession) => set({ teach: { ...state.teach, [s.id]: s } });

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

type Toast = (text: string) => void;
let toast: Toast = () => {};
export const onToast = (fn: Toast) => {
  toast = fn;
};

/** `fn` over the showing messages; the same list when it changes none, so nothing re-renders. */
function patchMessages(fn: (m: ThreadMessage) => ThreadMessage): ThreadMessage[] {
  let changed = false;
  const next = state.messages.map((m) => {
    const n = fn(m);
    if (n !== m) changed = true;
    return n;
  });
  return changed ? next : state.messages;
}
const patchMessage = (id: number, fn: (m: ThreadMessage) => ThreadMessage) =>
  patchMessages((m) => (m.id === id ? fn(m) : m));

// A reply streams in many small deltas: they're added up and shown once per frame.
const deltas = new Map<number, string>();
let deltaFrame = 0;
function flushDeltas() {
  if (deltaFrame) cancelAnimationFrame(deltaFrame);
  deltaFrame = 0;
  if (!deltas.size) return;
  const added = new Map(deltas);
  deltas.clear();
  const messages = patchMessages((m) => {
    const d = added.get(m.id);
    return d === undefined ? m : { ...m, text: m.text + d };
  });
  if (messages !== state.messages) set({ messages });
}

function apply(e: HatbotEvent) {
  if (e.type === "message.delta") {
    deltas.set(e.id, (deltas.get(e.id) ?? "") + e.text);
    if (!deltaFrame) deltaFrame = requestAnimationFrame(flushDeltas);
    return;
  }
  // Everything else lands after the deltas that came before it.
  flushDeltas();
  // TODO(shared): in HatbotEvent once packages/shared has them (contract #2).
  const type = (e as { type: string }).type;
  if (type === "settings.updated") return set({ settingsVersion: state.settingsVersion + 1 });
  if (type === "heartbeat.updated") return set({ heartbeatVersion: state.heartbeatVersion + 1 });
  switch (e.type) {
    case "message.created":
      if (e.message.incognito) incognitoIds.add(e.message.id);
      if (e.message.role === "assistant") refreshConversations();
      return set({
        // Only the conversation that's showing.
        messages:
          !!e.message.incognito === state.incognito &&
          e.message.conversationId === state.conversationId
            ? upsert(state.messages, e.message)
            : state.messages,
        unread:
          // What came of your own command arrives already seen.
          e.message.role === "assistant" && e.message.status !== "streaming" && !e.message.seenAt
            ? addUnread(e.message.id)
            : state.unread,
      });
    case "message.edited":
      refreshConversations();
      return set({
        messages: patchMessage(e.id, (m) => ({ ...m, editedAt: e.editedAt })),
        unread: addUnread(e.id),
      });
    case "message.rewrite":
      // Its task ended: its bot is writing it again.
      return set({
        messages: patchMessage(e.id, (m) => ({ ...m, text: "", status: "streaming" })),
      });
    case "message.seen":
      refreshConversations();
      return set({
        messages: patchMessages((m) => (e.ids.includes(m.id) ? { ...m, seenAt: e.seenAt } : m)),
        unread: state.unread.filter((id) => !e.ids.includes(id)),
      });
    case "message.deleted":
      refreshConversations();
      return set({
        messages: state.messages.some((m) => e.ids.includes(m.id))
          ? state.messages.filter((m) => !e.ids.includes(m.id))
          : state.messages,
        unread: state.unread.filter((id) => !e.ids.includes(id)),
      });
    case "message.progress": {
      const text = ((state.progress[e.id] ?? "") + e.text).slice(-400);
      return set({ progress: { ...state.progress, [e.id]: text } });
    }
    case "message.attachment":
      return set({
        messages: patchMessage(e.id, (m) =>
          m.attachments?.some((a) => a.id === e.attachment.id)
            ? m
            : { ...m, attachments: [...(m.attachments ?? []), e.attachment] },
        ),
      });
    case "message.task":
      return set({
        messages: patchMessage(e.id, (m) => ({ ...m, taskId: e.taskId })),
      });
    case "message.usage":
      return set({ usage: { ...state.usage, [e.id]: { tokens: e.tokens, costUsd: e.costUsd } } });
    case "message.done": {
      const { [e.id]: _, ...progress } = state.progress;
      const { [e.id]: __, ...usage } = state.usage;
      refreshConversations();
      return set({
        progress,
        usage,
        unread: addUnread(e.id),
        messages: patchMessage(e.id, (m) => ({ ...m, text: e.text, status: e.status })),
      });
    }
    case "spend.updated":
      return set({ todayUsd: e.todayUsd, monthUsd: e.monthUsd });
    case "proposal.updated":
      return putProposal(e.proposal);
    case "memory.committed":
      if (state.botIds.some((id) => botName(state, id) === e.author)) toast(`Memory: ${e.message}`);
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
      return set({ steps: { ...state.steps, [e.step.taskId]: steps } });
    }
    case "task.progress": {
      const text = ((state.taskProgress[e.taskId] ?? "") + e.text).slice(-400);
      return set({ taskProgress: { ...state.taskProgress, [e.taskId]: text } });
    }
    case "approval.created":
    case "approval.resolved":
      return set({ approvals: { ...state.approvals, [e.approval.id]: e.approval } });
    case "desktop.state":
      return set({ desktop: e.state });
    case "schedule.updated":
      return putSchedule(e.schedule);
    case "schedule.deleted":
      return set({ schedules: { ...state.schedules, [e.id]: null } });
    case "trigger.updated":
      return putTrigger(e.trigger);
    case "trigger.deleted":
      return set({ triggers: { ...state.triggers, [e.id]: null } });
    case "watcher.updated":
      return putWatcher(e.watcher);
    case "watcher.deleted":
      return set({ watchers: { ...state.watchers, [e.id]: null } });
    case "plugin.updated":
      return set({ plugins: { ...state.plugins, [e.plugin.id]: e.plugin } });
    case "teach.updated":
      return putTeach(e.session);
    case "episode.updated":
      return set({ episodes: { ...state.episodes, [e.episode.id]: e.episode } });
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
  const latest = await api<ThreadMessage[]>(page());
  await loadEpisodes(latest).catch(() => {});
  if (incognito !== state.incognito || conversationId !== state.conversationId) return;
  const first = latest[0];
  const last = state.messages.at(-1);
  // The whole conversation, or a full page past everything loaded (a gap): it starts again from here.
  if (!first || latest.length < PAGE || !last || last.id < first.id)
    return set({ messages: latest, hasEarlier: latest.length === PAGE });
  set({ messages: [...state.messages.filter((m) => m.id < first.id), ...latest] });
}

/** What may have changed while the stream was down. */
async function catchUp() {
  void refreshThread().catch(() => {});
  refreshConversations();
  void api<SpendSummary>("/spend/summary").then(
    (s) => set({ todayUsd: s.todayUsd, monthUsd: s.monthUsd }),
    () => {},
  );
  if (Object.keys(state.schedules).length || Object.keys(state.watchers).length)
    void loadSchedules().catch(() => {});
  const active = await loadTasks({ status: "active" }).catch(() => null);
  // Ones we thought running that aren't any more ended while we were away.
  if (active)
    for (const t of Object.values(state.tasks))
      if (t.finishedAt === null && !active.includes(t.id)) void loadTask(t.id).catch(() => {});
}

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
  const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${API_PREFIX}/stream`;
  const ws = new WebSocket(url);
  socket = ws;
  // A socket that's been replaced (StrictMode opens two) says nothing more.
  ws.onopen = () => {
    if (ws !== socket) return;
    if (opened) void catchUp();
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
    retryTimer = setTimeout(connect, Math.min(30_000, 1000 * 2 ** retry++));
  };
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
