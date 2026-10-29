import {
  APPROVAL_LEVELS,
  BOT_ID,
  CHAT_EFFORTS,
  SAFETY_KINDS,
  type SafetyKind,
} from "@hatbot/shared";
import { z } from "zod";
import type { Db } from "./db";

const Level = z.enum(APPROVAL_LEVELS);
/** Any provider's: one that's on is checked for when it's set. */
const ModelId = z.string().min(1).max(200);
const Safety = z.object({
  kinds: z.object(
    Object.fromEntries(SAFETY_KINDS.map((k) => [k, Level])) as Record<SafetyKind, typeof Level>,
  ),
  untrusted: z.boolean(),
  tools: z.record(z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), z.enum(["ask", "allow"])),
  chatCommands: z.number().int().min(1).max(50),
});

export const Settings = z.object({
  limits: z.object({
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
  /** Unless it's the expert model, the chat can ask the expert once per reply (ask_expert). */
  chatModel: ModelId,
  /** Name and email on memory commits you make from the UI. */
  owner: z.object({ name: z.string().min(1), email: z.string().min(1) }),
  paused: z.boolean(),
  /** Changes Haiku finds safe go ahead without asking. */
  reviewChanges: z.boolean(),
  safety: Safety,
  notificationsOpen: z.enum(["web", "app"]),
  desktopModel: ModelId,
  /** A desktop task the desktop model fails at carries on once on the expert model. */
  desktopEscalate: z.boolean(),
  /** The model background tasks run on (SSH, Proxmox, code work: anything without a screen). */
  taskModel: ModelId,
  /** Quick jobs: checks, summaries, research helpers, approval reviews. */
  smallModel: ModelId,
  /** Hard parts: what the chat asks for help with, memory proposals, teaching. */
  expertModel: ModelId,
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
/** Limits and approval kinds may change one at a time; `tools` is replaced whole. */
export const SettingsPatch = Settings.extend({
  limits: Settings.shape.limits.partial(),
  safety: Safety.extend({ kinds: Safety.shape.kinds.partial() }).partial(),
}).partial();
export type SettingsPatch = z.infer<typeof SettingsPatch>;

export const DEFAULT_SETTINGS: Settings = {
  limits: {
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
  safety: {
    kinds: {
      send: "review",
      submit_personal_data: "review",
      delete: "review",
      other: "review",
      purchase: "ask",
      payment: "ask",
      account_security: "ask",
      access: "ask",
      computer: "ask",
    },
    untrusted: true,
    tools: {},
    chatCommands: 2,
  },
  notificationsOpen: "web",
  desktopModel: "claude-haiku-5-5",
  desktopEscalate: true,
  taskModel: "claude-haiku-5-5",
  smallModel: "claude-haiku-5-5",
  expertModel: "claude-opus-5-5",
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

export function deleteSetting(db: Db, key: string) {
  db.query("DELETE FROM settings WHERE key = ?").run(key);
}

function merged(base: Settings, patch: SettingsPatch): Settings {
  const safety = { ...base.safety, ...patch.safety };
  return {
    ...base,
    ...patch,
    limits: { ...base.limits, ...patch.limits },
    safety: { ...safety, kinds: { ...base.safety.kinds, ...patch.safety?.kinds } },
  };
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
    // Settings saved before a new one existed take its default.
    return Settings.parse(merged(DEFAULT_SETTINGS, stored));
  }

  update(patch: SettingsPatch): Settings {
    const next = Settings.parse(merged(this.get(), patch));
    setSetting(this.db, "app", JSON.stringify(next));
    return next;
  }
}
