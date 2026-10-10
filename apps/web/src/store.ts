// Live client state: the thread, tasks, approvals, the desktop, pause state and spend, fed by the WebSocket.
import {
  API_PREFIX,
  type Approval,
  type DesktopState,
  type HatbotEvent,
  type PluginInfo,
  type Schedule,
  type Task,
  type TaskStep,
  type ThreadMessage,
  type Trigger,
} from "@hatbot/shared";
import { useSyncExternalStore } from "react";
import { ApiError, api } from "./api";

type State = {
  messages: ThreadMessage[];
  /** Latest progress note per streaming message. */
  progress: Record<number, string>;
  hasEarlier: boolean;
  paused: boolean;
  todayUsd: number | null;
  monthUsd: number | null;
  memoryVersion: number;
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
  plugins: Record<string, PluginInfo>;
};

let state: State = {
  messages: [],
  progress: {},
  hasEarlier: false,
  paused: false,
  todayUsd: null,
  monthUsd: null,
  memoryVersion: 0,
  connected: false,
  tasks: {},
  steps: {},
  taskProgress: {},
  approvals: {},
  desktop: null,
  schedules: {},
  triggers: {},
  plugins: {},
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
const upsert = (list: ThreadMessage[], m: ThreadMessage) =>
  list.some((x) => x.id === m.id)
    ? list.map((x) => (x.id === m.id ? { ...x, ...m } : x))
    : [...list, m].sort((a, b) => a.id - b.id);

export async function loadThread() {
  const messages = await api<ThreadMessage[]>(`/thread/messages?limit=${PAGE}`);
  set({ messages, hasEarlier: messages.length === PAGE });
}

export async function loadEarlier() {
  const first = state.messages[0];
  if (!first) return;
  const older = await api<ThreadMessage[]>(`/thread/messages?limit=${PAGE}&before=${first.id}`);
  set({ messages: [...older, ...state.messages], hasEarlier: older.length === PAGE });
}

export async function sendMessage(text: string) {
  const m = await api<ThreadMessage>("/thread/messages", { body: { text } });
  set({ messages: upsert(state.messages, m) });
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
  filter: { status?: "active" | "done"; scheduleId?: number; triggerId?: number } = {},
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
  const [schedules, triggers] = await Promise.all([
    api<Schedule[]>("/schedules"),
    api<Trigger[]>("/triggers"),
  ]);
  set({
    schedules: { ...state.schedules, ...Object.fromEntries(schedules.map((s) => [s.id, s])) },
    triggers: { ...state.triggers, ...Object.fromEntries(triggers.map((t) => [t.id, t])) },
  });
  return { schedules: schedules.map((s) => s.id), triggers: triggers.map((t) => t.id) };
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

export const putSchedule = (s: Schedule) => set({ schedules: { ...state.schedules, [s.id]: s } });
export const putTrigger = (t: Trigger) => set({ triggers: { ...state.triggers, [t.id]: t } });

export async function saveSchedule(id: number, patch: Partial<Schedule> & { at?: string }) {
  const s = await api<Schedule>(`/schedules/${id}`, { method: "PATCH", body: patch });
  putSchedule(s);
  return s;
}

async function loadLive() {
  const [pending, desktop] = await Promise.all([
    api<Approval[]>("/approvals?pending=1"),
    api<DesktopState>("/desktop/status").catch(() => null),
  ]);
  const approvals = { ...state.approvals };
  // Anything we thought pending but the server doesn't list was decided while we were away.
  for (const a of Object.values(approvals))
    if (a.status === "pending") requested.delete(`a${a.id}`);
  for (const a of Object.values(approvals))
    if (a.status === "pending" && !pending.some((p) => p.id === a.id)) delete approvals[a.id];
  for (const a of pending) approvals[a.id] = a;
  set({ approvals, desktop });
  for (const t of Object.values(state.tasks))
    if (state.steps[t.id] && t.finishedAt === null) void loadTask(t.id).catch(() => {});
}

export async function decideApproval(id: number, decision: "approve" | "deny") {
  const a = await api<Approval>(`/approvals/${id}`, { body: { decision } });
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

/** Approvals waiting for you, plus a takeover request. */
export const needsYou = (s: State) =>
  Object.values(s.approvals).filter((a) => a.status === "pending").length +
  (s.desktop?.request ? 1 : 0);

type Toast = (text: string) => void;
let toast: Toast = () => {};
export const onToast = (fn: Toast) => {
  toast = fn;
};

function apply(e: HatbotEvent) {
  switch (e.type) {
    case "message.created":
      return set({ messages: upsert(state.messages, e.message) });
    case "message.delta":
      return set({
        messages: state.messages.map((m) => (m.id === e.id ? { ...m, text: m.text + e.text } : m)),
      });
    case "message.progress": {
      const text = ((state.progress[e.id] ?? "") + e.text).slice(-400);
      return set({ progress: { ...state.progress, [e.id]: text } });
    }
    case "message.task":
      return set({
        messages: state.messages.map((m) => (m.id === e.id ? { ...m, taskId: e.taskId } : m)),
      });
    case "message.done": {
      const { [e.id]: _, ...progress } = state.progress;
      return set({
        progress,
        messages: state.messages.map((m) =>
          m.id === e.id ? { ...m, text: e.text, status: e.status } : m,
        ),
      });
    }
    case "spend.updated":
      return set({ todayUsd: e.todayUsd, monthUsd: e.monthUsd });
    case "memory.committed":
      if (e.author === "Hatbot") toast(`Memory: ${e.message}`);
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
    case "plugin.updated":
      return set({ plugins: { ...state.plugins, [e.plugin.id]: e.plugin } });
  }
}

let socket: WebSocket | null = null;
let retry = 0;
let stopped = false;

/** Opens the event stream and keeps it open, reloading the thread after a reconnect. */
export function connect() {
  stopped = false;
  const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${API_PREFIX}/stream`;
  socket = new WebSocket(url);
  socket.onopen = () => {
    if (retry > 0) void loadThread();
    void loadLive().catch(() => {});
    retry = 0;
    set({ connected: true });
  };
  socket.onmessage = (ev) => apply(JSON.parse(ev.data) as HatbotEvent);
  socket.onclose = () => {
    set({ connected: false });
    socket = null;
    if (stopped) return;
    const delay = Math.min(30_000, 1000 * 2 ** retry++);
    setTimeout(connect, delay);
  };
}

export function disconnect() {
  stopped = true;
  socket?.close();
}
