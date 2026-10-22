import { BOT_ID, CHAT_EFFORTS } from "@hatbot/shared";
import { z } from "zod";
import type { Db } from "./db";

export const Settings = z.object({
  limits: z.object({
    taskUsd: z.number().positive(),
    /** A research task's lead and helpers cost more than most tasks. */
    researchUsd: z.number().positive(),
    dailyUsd: z.number().positive(),
    monthlyUsd: z.number().positive(),
    /** The last of the daily and monthly limits, which only alerts and the heartbeat spend. */
    alertReserveUsd: z.number().min(0),
    /** What boxes' pages may spend asking Haiku in a day; 0 stops them. */
    boxesUsd: z.number().min(0),
  }),
  chatEffort: z.enum(CHAT_EFFORTS),
  /** On Haiku 5.5 the chat can ask Opus 5.5 once per reply (ask_opus). */
  chatModel: z.enum(["claude-haiku-5-5", "claude-opus-5-5"]),
  /** Name and email on memory commits you make from the UI. */
  owner: z.object({ name: z.string().min(1), email: z.string().min(1) }),
  paused: z.boolean(),
  /** Changes Haiku finds safe go ahead without asking. */
  reviewChanges: z.boolean(),
  notificationsOpen: z.enum(["web", "app"]),
  /** Haiku 5.5 is far cheaper, Opus 5.5 fails less. */
  desktopModel: z.enum(["claude-opus-5-5", "claude-haiku-5-5"]),
  /** A desktop task Haiku fails at carries on once on Opus. */
  desktopEscalate: z.boolean(),
  /** The model background tasks run on (SSH, Proxmox, code work: anything without a screen). */
  taskModel: z.enum(["claude-haiku-5-5", "claude-opus-5-5"]),
  heartbeat: z.object({
    enabled: z.boolean(),
    everyMinutes: z.number().int().min(5).max(1440),
    botId: z.string().regex(BOT_ID),
    instructions: z.string().trim().min(1).max(4000),
  }),
  memoryTidy: z.boolean(),
  weeklyReport: z.object({
    enabled: z.boolean(),
    weekday: z.number().int().min(0).max(6),
    hour: z.number().int().min(0).max(23),
  }),
  /** The local hour of the to-do list's morning reminder. */
  todoHour: z.number().int().min(0).max(23),
});
export type Settings = z.infer<typeof Settings>;
/** Limits may change one at a time. */
export const SettingsPatch = Settings.extend({ limits: Settings.shape.limits.partial() }).partial();
export type SettingsPatch = z.infer<typeof SettingsPatch>;

export const DEFAULT_SETTINGS: Settings = {
  limits: {
    taskUsd: 3,
    researchUsd: 5,
    dailyUsd: 10,
    monthlyUsd: 200,
    alertReserveUsd: 1,
    boxesUsd: 0.5,
  },
  chatEffort: "low",
  chatModel: "claude-haiku-5-5",
  owner: { name: "You", email: "owner@local" },
  paused: false,
  reviewChanges: true,
  notificationsOpen: "web",
  desktopModel: "claude-haiku-5-5",
  desktopEscalate: true,
  taskModel: "claude-haiku-5-5",
  heartbeat: {
    enabled: true,
    everyMinutes: 30,
    botId: "hatbot",
    instructions:
      "Tell me about anything that needs me: a service down for more than a moment, failed backups, tasks that keep failing, approvals I missed. If a service is down and a restart is likely to fix it, restart it once and check it's back. Don't change configuration or delete anything. Leave alone what fixes itself or that I'd already know about.",
  },
  memoryTidy: false,
  weeklyReport: { enabled: true, weekday: 1, hour: 9 },
  todoHour: 9,
};

export const getSetting = (db: Db, key: string): string | null =>
  db.query<{ value: string }, [string]>("SELECT value FROM settings WHERE key = ?").get(key)
    ?.value ?? null;

export function setSetting(db: Db, key: string, value: string) {
  db.query(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

export class SettingsStore {
  constructor(private db: Db) {}

  get(): Settings {
    const row = getSetting(this.db, "app");
    const stored = row
      ? (JSON.parse(row) as Partial<Settings> & { reviewTaintedChanges?: boolean })
      : {};
    // reviewChanges was reviewTaintedChanges, for tainted work only.
    if (stored.reviewTaintedChanges !== undefined)
      stored.reviewChanges ??= stored.reviewTaintedChanges;
    // Limits saved before a new one existed take its default.
    const limits = { ...DEFAULT_SETTINGS.limits, ...stored.limits };
    return Settings.parse({ ...DEFAULT_SETTINGS, ...stored, limits });
  }

  update(patch: SettingsPatch): Settings {
    const now = this.get();
    const next = Settings.parse({ ...now, ...patch, limits: { ...now.limits, ...patch.limits } });
    setSetting(this.db, "app", JSON.stringify(next));
    return next;
  }
}
