// Schedules (PLAN.md §4.1, §5.6): cron or one-off, stored in SQLite, run in-process as background tasks.
import { HATBOT_ID, type Schedule } from "@hatbot/shared";
import { Cron } from "croner";
import { liveBot } from "./bots";
import type { Db } from "./db";
import type { EventBus } from "./events";
import type { SettingsStore } from "./settings";
import type { Tasks } from "./tasks/service";

/** Runs closer together than this cost too much to be worth it. */
const MIN_GAP_MS = 5 * 60_000;

export class ScheduleError extends Error {}

type Row = {
  id: number;
  name: string;
  cron: string | null;
  run_at: string | null;
  prompt: string;
  enabled: number;
  created_via: Schedule["createdVia"];
  created_at: string;
  next_run_at: string | null;
  last_run_at: string | null;
  last_task_id: number | null;
  tainted: number;
  tainted_by: string | null;
  bot_id: string;
};

const SELECT = `SELECT s.*, (SELECT max(id) FROM tasks t WHERE t.schedule_id = s.id) AS last_task_id
  FROM schedules s`;

const toSchedule = (r: Row): Schedule => ({
  id: r.id,
  name: r.name,
  cron: r.cron,
  runAt: r.run_at,
  prompt: r.prompt,
  enabled: Boolean(r.enabled),
  createdVia: r.created_via,
  createdAt: r.created_at,
  nextRunAt: r.next_run_at,
  lastRunAt: r.last_run_at,
  lastTaskId: r.last_task_id,
  tainted: Boolean(r.tainted),
  taintedBy: r.tainted_by,
  botId: r.bot_id,
});

export type ScheduleInput = {
  name?: string;
  prompt?: string;
  enabled?: boolean;
  cron?: string;
  at?: string;
  botId?: string;
};

export class Schedules {
  private clock: () => number;

  constructor(
    private db: Db,
    private events: EventBus,
    private settings: SettingsStore,
    private tasks: Tasks,
    clock?: () => number,
  ) {
    this.clock = clock ?? Date.now;
  }

  private now() {
    return new Date(this.clock()).toISOString();
  }

  list(): Schedule[] {
    return this.db.query<Row, []>(`${SELECT} ORDER BY s.name, s.id`).all().map(toSchedule);
  }

  get(id: number): Schedule | null {
    const r = this.db.query<Row, [number]>(`${SELECT} WHERE s.id = ?`).get(id);
    return r ? toSchedule(r) : null;
  }

  /** Throws ScheduleError with a message for the owner (or the model) when the time is wrong. */
  create(
    input: ScheduleInput & { name: string; prompt: string },
    via: "chat" | "owner",
    /** What the chat had read, when it had read untrusted content. */
    taintedBy: string | null = null,
  ): Schedule {
    taintedBy = via === "chat" ? taintedBy : null;
    const when = this.when(input.cron, input.at);
    const enabled = input.enabled ?? true;
    const row = this.db
      .query<
        { id: number },
        [
          string,
          string | null,
          string | null,
          string,
          number,
          string,
          string,
          string | null,
          number,
          string | null,
          string,
        ]
      >(
        `INSERT INTO schedules (name, cron, run_at, prompt, enabled, created_via, created_at, next_run_at, tainted, tainted_by, bot_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(
        input.name,
        when.cron,
        when.runAt,
        input.prompt,
        enabled ? 1 : 0,
        via,
        this.now(),
        enabled ? when.next : null,
        taintedBy ? 1 : 0,
        taintedBy,
        input.botId ?? HATBOT_ID,
      );
    return this.changed(row?.id ?? -1) as Schedule;
  }

  /**
   * `by`: you, from the app (saving the instructions clears the tainted mark), or the chat
   * (`taintedBy`: what untrusted content it had read, which sets the mark).
   */
  update(
    id: number,
    patch: ScheduleInput,
    by: { via: "owner" } | { via: "chat"; taintedBy: string | null } = { via: "owner" },
  ): Schedule | null {
    const current = this.get(id);
    if (!current) return null;
    const timeChanged = patch.cron !== undefined || patch.at !== undefined;
    const enabled = patch.enabled ?? current.enabled;
    let { cron, runAt, nextRunAt } = current;
    if (timeChanged || (enabled && !current.enabled)) {
      const when = this.when(
        timeChanged ? patch.cron : (current.cron ?? undefined),
        timeChanged ? patch.at : (current.runAt ?? undefined),
      );
      ({ cron, runAt } = when);
      nextRunAt = when.next;
    }
    // Your saving its instructions clears the mark; switching it on or off doesn't.
    const tainted =
      by.via === "owner"
        ? patch.prompt === undefined && current.tainted
        : Boolean(by.taintedBy) || current.tainted;
    // The first thing that tainted it stays.
    const taintedBy = tainted
      ? current.tainted
        ? current.taintedBy
        : by.via === "chat" && by.taintedBy
      : null;
    this.db
      .query(
        "UPDATE schedules SET name = ?, prompt = ?, cron = ?, run_at = ?, enabled = ?, next_run_at = ?, tainted = ?, tainted_by = ?, bot_id = ? WHERE id = ?",
      )
      .run(
        patch.name ?? current.name,
        patch.prompt ?? current.prompt,
        cron,
        runAt,
        enabled ? 1 : 0,
        enabled ? nextRunAt : null,
        tainted ? 1 : 0,
        taintedBy || null,
        patch.botId ?? current.botId,
        id,
      );
    return this.changed(id);
  }

  delete(id: number): boolean {
    const gone = this.db.query("DELETE FROM schedules WHERE id = ?").run(id).changes > 0;
    if (gone) this.events.emit({ type: "schedule.deleted", id });
    return gone;
  }

  /** Starts a run now, outside the schedule. Null if the last run is still going. */
  runNow(id: number) {
    const s = this.get(id);
    if (!s) return null;
    return this.fire(s);
  }

  /**
   * Starts every run that's due; the brain calls it every few seconds. Runs missed while the brain was
   * down or paused happen once, when it's back.
   */
  tick() {
    if (this.settings.get().paused) return;
    const due = this.db
      .query<Row, [string]>(
        `${SELECT} WHERE s.enabled = 1 AND s.next_run_at IS NOT NULL AND s.next_run_at <= ? ORDER BY s.next_run_at`,
      )
      .all(this.now())
      .map(toSchedule);
    for (const s of due) {
      // The next run counts from now, so a long outage doesn't queue up a run per missed time.
      const next = s.cron ? this.nextRun(s.cron) : null;
      this.db
        .query("UPDATE schedules SET next_run_at = ?, enabled = ? WHERE id = ?")
        .run(next, s.cron ? 1 : 0, s.id);
      if (!this.fire(s)) {
        console.log(`schedule ${s.id} "${s.name}" skipped: its last run is still going`);
      }
      this.changed(s.id);
    }
  }

  private fire(s: Schedule) {
    const task = this.tasks.createBackgroundTask({
      title: s.name,
      goal: s.prompt,
      origin: "schedule",
      source: s.name,
      scheduleId: s.id,
      botId: liveBot(this.db, s.botId),
      runKey: `schedule:${s.id}`,
      taintedBy: s.tainted
        ? `Its schedule, which the chat wrote after reading: ${s.taintedBy ?? "untrusted content"}`
        : null,
    });
    if (!task) return null;
    this.db.query("UPDATE schedules SET last_run_at = ? WHERE id = ?").run(this.now(), s.id);
    this.changed(s.id);
    return task;
  }

  private changed(id: number) {
    const schedule = this.get(id);
    if (schedule) this.events.emit({ type: "schedule.updated", schedule });
    return schedule;
  }

  private nextRun(cron: string): string | null {
    return new Cron(cron, { paused: true }).nextRun(new Date(this.clock()))?.toISOString() ?? null;
  }

  /** Checks a cron expression or a one-off time and works out the next run. */
  private when(
    cron?: string,
    at?: string,
  ): { cron: string | null; runAt: string | null; next: string | null } {
    if (cron && at) throw new ScheduleError("Give either a cron expression or a time, not both.");
    if (cron) {
      if (cron.trim().split(/\s+/).length !== 5 && !cron.trim().startsWith("@"))
        throw new ScheduleError(
          'Use a five-field cron expression: minute hour day-of-month month day-of-week, e.g. "0 8 * * *".',
        );
      let job: Cron;
      try {
        job = new Cron(cron, { paused: true });
      } catch (err) {
        throw new ScheduleError(`That cron expression doesn't work: ${(err as Error).message}`);
      }
      const [a, b] = job.nextRuns(2, new Date(this.clock()));
      if (!a) throw new ScheduleError("That cron expression never runs.");
      if (b && b.getTime() - a.getTime() < MIN_GAP_MS)
        throw new ScheduleError("Schedules can run at most every 5 minutes.");
      return { cron: cron.trim(), runAt: null, next: a.toISOString() };
    }
    if (at) {
      let time: Date | null = null;
      try {
        // Without an offset, croner reads it in the brain's time zone, like the chat's timestamps.
        time = new Cron(at, { paused: true }).nextRun(new Date(this.clock() - 60_000));
      } catch {
        throw new ScheduleError('Give the time as an ISO date and time, e.g. "2026-10-11T08:00".');
      }
      if (!time || time.getTime() < this.clock() - 60_000)
        throw new ScheduleError("That time has already passed.");
      return { cron: null, runAt: time.toISOString(), next: time.toISOString() };
    }
    throw new ScheduleError("Give a cron expression or a time.");
  }
}
