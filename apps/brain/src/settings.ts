import { z } from "zod";
import type { Db } from "./db";

export const Settings = z.object({
  limits: z.object({
    taskUsd: z.number().positive(),
    dailyUsd: z.number().positive(),
    monthlyUsd: z.number().positive(),
  }),
  /** Effort for the chat thread. Heavier work runs as tasks, at their own effort. */
  chatEffort: z.enum(["low", "medium"]),
  /** The chat's model. On Haiku 5.5 the chat can ask Opus 5.5 once per reply (ask_opus). */
  chatModel: z.enum(["claude-haiku-5-5", "claude-opus-5-5"]),
  /** Name and email on memory commits you make from the UI. */
  owner: z.object({ name: z.string().min(1), email: z.string().min(1) }),
  /** Pause all (PLAN.md §6.5). */
  paused: z.boolean(),
  /** Changes Haiku finds safe go ahead without asking (PLAN.md §6.1). */
  reviewChanges: z.boolean(),
  /** What tapping a notification opens: the web app, or the iOS app (hatbot:// links). */
  notificationsOpen: z.enum(["web", "app"]),
  /** The model that drives the desktop (PLAN.md §5.4). Haiku 5.5 is the experiment: far cheaper, less tested. */
  desktopModel: z.enum(["claude-opus-5-5", "claude-haiku-5-5"]),
  /** The model background tasks run on (SSH, Proxmox, code work: anything without a screen). */
  taskModel: z.enum(["claude-haiku-5-5", "claude-opus-5-5"]),
});
export type Settings = z.infer<typeof Settings>;

export const DEFAULT_SETTINGS: Settings = {
  limits: { taskUsd: 3, dailyUsd: 10, monthlyUsd: 200 },
  chatEffort: "low",
  chatModel: "claude-haiku-5-5",
  owner: { name: "You", email: "owner@local" },
  paused: false,
  reviewChanges: true,
  notificationsOpen: "web",
  desktopModel: "claude-opus-5-5",
  taskModel: "claude-haiku-5-5",
};

export class SettingsStore {
  constructor(private db: Db) {}

  get(): Settings {
    const row = this.db
      .query<{ value: string }, []>("SELECT value FROM settings WHERE key = 'app'")
      .get();
    const stored = row
      ? (JSON.parse(row.value) as Partial<Settings> & { reviewTaintedChanges?: boolean })
      : {};
    // reviewChanges was reviewTaintedChanges, for tainted work only.
    if (stored.reviewTaintedChanges !== undefined)
      stored.reviewChanges ??= stored.reviewTaintedChanges;
    return Settings.parse({ ...DEFAULT_SETTINGS, ...stored });
  }

  update(patch: Partial<Settings>): Settings {
    const next = Settings.parse({ ...this.get(), ...patch });
    this.db
      .query(
        "INSERT INTO settings (key, value) VALUES ('app', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      )
      .run(JSON.stringify(next));
    return next;
  }
}
