// Live client state: the thread, pause state and spend, fed by the WebSocket.
import { API_PREFIX, type HatbotEvent, type ThreadMessage } from "@hatbot/shared";
import { useSyncExternalStore } from "react";
import { api } from "./api";

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
