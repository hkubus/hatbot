// Reminders from the to-do list (PLAN.md §19): each morning, what's due or overdue; and an item due at
// a time, at that time. Without the model: a reminder you asked for mustn't hang on a triage calling it
// noise, as the heartbeat's may.
import { HATBOT_ID, localDay, parseTodos, TODO_FILE, type Todo, todoLine } from "@hatbot/shared";
import type { Chats } from "./agent/chats";
import type { Db } from "./db";
import type { MemoryStore } from "./memory/store";
import type { Notifier } from "./notify";
import { getSetting, type SettingsStore, setSetting } from "./settings";

const STATE_KEY = "todo:reminders";
/** An item whose time passed longer ago than this (the brain was down) is left to the morning list. */
const LATE_MS = 6 * 3600_000;

type State = {
  /** The day the morning list last went out. */
  morning: string | null;
  /** Timed items already told, by key: an item moved to another time is a new one. */
  told: string[];
};

export type TodoRemindersDeps = {
  db: Db;
  memory: MemoryStore;
  settings: SettingsStore;
  notifier: Notifier;
  chats: Chats;
  publicUrl: string;
  clock?: () => number;
};

const keyOf = (t: Todo) => `${t.text}|${t.due} ${t.at}`;

/** When a timed item is due, in local time. */
const dueAt = (t: Todo) => {
  const [y, m, d] = (t.due ?? "").split("-").map(Number) as [number, number, number];
  const [h, min] = (t.at ?? "").split(":").map(Number) as [number, number];
  return new Date(y, m - 1, d, h, min).getTime();
};

export class TodoReminders {
  private running = false;
  private clock: () => number;

  constructor(private d: TodoRemindersDeps) {
    this.clock = d.clock ?? Date.now;
  }

  /** Sends what's due; the brain calls it every minute. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.look();
    } finally {
      this.running = false;
    }
  }

  private async look() {
    const now = this.clock();
    const today = localDay(new Date(now));
    const open = parseTodos((await this.d.memory.readOrNull(TODO_FILE)) ?? "").filter(
      (t) => !t.done && t.due,
    );
    const state = this.state();
    const timed = open.filter((t) => t.at);
    for (const t of timed) {
      const at = dueAt(t);
      if (at > now || now - at > LATE_MS || state.told.includes(keyOf(t))) continue;
      this.send(t.text);
      state.told.push(keyOf(t));
    }
    // Only what's still open is kept.
    const keys = new Set(timed.map(keyOf));
    state.told = state.told.filter((k) => keys.has(k));
    // At the hour set, or at the first look after it that day.
    if (new Date(now).getHours() >= this.d.settings.get().todoHour && state.morning !== today) {
      state.morning = today;
      const dueToday = open.filter((t) => t.due === today);
      const overdue = open.filter((t) => (t.due ?? "") < today);
      const part = (title: string, list: Todo[]) =>
        list.length ? [`${title}:`, ...list.map((t) => `- ${todoLine(t)}`)] : [];
      const lines = [...part("Due today", dueToday), ...part("Overdue", overdue)];
      if (lines.length) this.send(lines.join("\n"));
    }
    this.save(state);
  }

  /** In Hatbot's chat, and as a notification that opens the list. */
  private send(message: string) {
    this.d.chats.note(HATBOT_ID, `**To-do**: ${message}`);
    void this.d.notifier.send({
      title: "To-do",
      message: message.slice(0, 1000),
      priority: 3,
      click: `${this.d.publicUrl}/read?path=${TODO_FILE}`,
    });
  }

  private state(): State {
    const row = getSetting(this.d.db, STATE_KEY);
    return {
      morning: null,
      told: [],
      ...(row === null ? {} : (JSON.parse(row) as Partial<State>)),
    };
  }

  private save(s: State) {
    setSetting(this.d.db, STATE_KEY, JSON.stringify(s));
  }
}
