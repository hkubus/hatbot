import { z } from "zod";
import type { Db } from "./db";

export const Settings = z.object({
  limits: z.object({
    taskUsd: z.number().positive(),
    dailyUsd: z.number().positive(),
    monthlyUsd: z.number().positive(),
  }),
  /** Effort for the chat thread (Opus 5.5). Heavier work runs as tasks, at their own effort. */
  chatEffort: z.enum(["low", "medium"]),
  /** Name and email on memory commits you make from the UI. */
  owner: z.object({ name: z.string().min(1), email: z.string().min(1) }),
  /** Pause all (PLAN.md §6.5). */
  paused: z.boolean(),
});
export type Settings = z.infer<typeof Settings>;

export const DEFAULT_SETTINGS: Settings = {
  limits: { taskUsd: 3, dailyUsd: 10, monthlyUsd: 200 },
  chatEffort: "low",
  owner: { name: "You", email: "owner@local" },
  paused: false,
};

export class SettingsStore {
  constructor(private db: Db) {}

  get(): Settings {
    const row = this.db
      .query<{ value: string }, []>("SELECT value FROM settings WHERE key = 'app'")
      .get();
    const stored = row ? (JSON.parse(row.value) as Partial<Settings>) : {};
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
