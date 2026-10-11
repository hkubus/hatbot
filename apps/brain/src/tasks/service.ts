// Tasks (PLAN.md §5.1): storage, cards in the thread, the timeline, and starting runs.
import type { ACTIVE_TASK_STATUSES, Task, TaskStatus, TaskStep } from "@hatbot/shared";
import type { ModelClient } from "../agent/model";
import type { Thread } from "../agent/thread";
import type { ToolContext } from "../agent/tools";
import type { Approvals } from "../approvals";
import type { Archive } from "../archive";
import type { Config } from "../config";
import type { Db } from "../db";
import type { Desktop } from "../desktop/service";
import type { EventBus } from "../events";
import type { MemoryStore } from "../memory/store";
import type { Notifier } from "../notify";
import type { Plugins } from "../plugins/registry";
import type { SettingsStore } from "../settings";
import type { Spend } from "../spend";
import type { Skills } from "../teach/skills";
import { runAgentTask } from "./agent-run";
import { runDesktopTask } from "./desktop-run";
import { Pool, ScreenLane } from "./lane";

export type TasksDeps = {
  db: Db;
  events: EventBus;
  spend: Spend;
  settings: SettingsStore;
  model: ModelClient;
  desktop: Desktop;
  approvals: Approvals;
  notifier: Notifier;
  archive: Archive;
  thread: Thread;
  config: Config;
  memory: MemoryStore;
  plugins: Plugins;
  skills: Skills;
  clock?: () => number;
};

/** Background tasks at once (PLAN.md §5.6). */
const BACKGROUND_SLOTS = 3;

type Row = {
  id: number;
  title: string;
  goal: string;
  success_criteria: string;
  origin: Task["origin"];
  lane: Task["lane"];
  source: string | null;
  schedule_id: number | null;
  trigger_id: number | null;
  parent_id: number | null;
  payload: string | null;
  model: string;
  skill: string | null;
  effort: Task["effort"];
  status: TaskStatus;
  tainted: number;
  injection_suspected: number;
  budget_usd: number;
  summary: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  cost_usd: number | null;
  steps: number;
};

const SELECT = `SELECT t.*,
  (SELECT sum(cost_usd) FROM spend_ledger s WHERE s.task_id = t.id) AS cost_usd,
  (SELECT count(*) FROM task_steps st WHERE st.task_id = t.id AND st.kind = 'action') AS steps
  FROM tasks t`;

const toTask = (r: Row): Task => ({
  id: r.id,
  title: r.title,
  goal: r.goal,
  successCriteria: r.success_criteria,
  origin: r.origin,
  lane: r.lane,
  source: r.source,
  scheduleId: r.schedule_id,
  triggerId: r.trigger_id,
  parentId: r.parent_id,
  payload: r.payload,
  model: r.model,
  skill: r.skill,
  effort: r.effort,
  status: r.status,
  tainted: Boolean(r.tainted),
  injectionSuspected: Boolean(r.injection_suspected),
  summary: r.summary,
  costUsd: r.cost_usd ?? 0,
  steps: r.steps,
  createdAt: r.created_at,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
});

const ACTIVE: typeof ACTIVE_TASK_STATUSES = [
  "queued",
  "running",
  "waiting_approval",
  "waiting_takeover",
];
const FINAL: TaskStatus[] = ["done", "failed", "cancelled"];

export class Tasks {
  readonly lane = new ScreenLane();
  readonly pool = new Pool(BACKGROUND_SLOTS);
  private running = new Map<number, AbortController>();
  /** Events for running tasks, delivered with their next tool results. */
  private inbox = new Map<number, string[]>();
  private runs = new Set<Promise<void>>();
  readonly clock: () => number;

  constructor(readonly d: TasksDeps) {
    this.clock = d.clock ?? Date.now;
    // A restart ends every task that was in flight; their runs can't be resumed.
    d.db
      .query(
        `UPDATE tasks SET status = 'failed', summary = coalesce(summary, 'Stopped: the brain restarted.'),
         finished_at = ? WHERE status IN (${ACTIVE.map(() => "?").join(", ")})`,
      )
      .run(this.now(), ...ACTIVE);
    d.approvals.onCreated = (a) => {
      if (a.taskId)
        d.thread.addCard("approval", `Approval needed: ${a.summary}`, {
          taskId: a.taskId,
          approvalId: a.id,
        });
    };
  }

  now() {
    return new Date(this.clock()).toISOString();
  }

  get(id: number): Task | null {
    const r = this.d.db.query<Row, [number]>(`${SELECT} WHERE t.id = ?`).get(id);
    return r ? toTask(r) : null;
  }

  list(
    opts: {
      status?: "active" | "done";
      scheduleId?: number;
      triggerId?: number;
      limit?: number;
    } = {},
  ): Task[] {
    const where: string[] = [];
    const args: number[] = [];
    if (opts.status === "active")
      where.push(`t.status IN (${ACTIVE.map((s) => `'${s}'`).join(", ")})`);
    if (opts.status === "done")
      where.push(`t.status IN (${FINAL.map((s) => `'${s}'`).join(", ")})`);
    // A schedule's or trigger's own runs, not the desktop tasks they started.
    if (opts.scheduleId !== undefined) {
      where.push("t.schedule_id = ? AND t.parent_id IS NULL");
      args.push(opts.scheduleId);
    }
    if (opts.triggerId !== undefined) {
      where.push("t.trigger_id = ? AND t.parent_id IS NULL");
      args.push(opts.triggerId);
    }
    return this.d.db
      .query<Row, number[]>(
        `${SELECT} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY t.id DESC LIMIT ?`,
      )
      .all(...args, opts.limit ?? 50)
      .map(toTask);
  }

  steps(taskId: number): TaskStep[] {
    return this.d.db
      .query<TaskStep, [number]>(
        `SELECT id, task_id AS taskId, kind, name, detail, screenshot, url, created_at AS createdAt
         FROM task_steps WHERE task_id = ? ORDER BY id`,
      )
      .all(taskId);
  }

  step(taskId: number, stepId: number): TaskStep | null {
    return this.steps(taskId).find((s) => s.id === stepId) ?? null;
  }

  /**
   * Starts a desktop task, then a run that waits for the screen lane. It shows under the chat reply that
   * started it (`message`), or as its own card. One started by a background task (`parent`) shows
   * nowhere in the thread; its parent reports.
   */
  createDesktopTask(input: {
    title: string;
    goal: string;
    successCriteria: string;
    origin: Task["origin"];
    /** A skill to follow, from skills/<name>.md. */
    skill?: string;
    parent?: Task;
    message?: number;
  }): Task {
    const p = input.parent;
    const id = this.insert({
      title: input.title,
      goal: input.goal,
      success_criteria: input.successCriteria,
      origin: input.origin,
      lane: "screen",
      // Fixed for the task: a settings change applies to tasks started after it.
      model: this.d.settings.get().desktopModel,
      skill: input.skill ?? null,
      parent_id: p?.id ?? null,
      source: p?.source ?? null,
      schedule_id: p?.scheduleId ?? null,
      trigger_id: p?.triggerId ?? null,
    });
    if (!p && !(input.message && this.d.thread.attachTask(input.message, id)))
      this.d.thread.addCard("task", `Task #${id}: ${input.title}`, { taskId: id });
    this.emit(id);
    this.start(id);
    return this.get(id) as Task;
  }

  /**
   * Starts a background task (PLAN.md §5.6). One the chat starts (`run_task`) shows under the reply that
   * started it (`message`). A schedule's or trigger's card goes in the thread when it ends, if there's
   * something to tell. Null if the same `runKey` is still running: one run at a time.
   */
  createBackgroundTask(input: {
    title: string;
    goal: string;
    origin: Task["origin"];
    source?: string;
    scheduleId?: number;
    triggerId?: number;
    runKey?: string;
    /** The event that started it. Untrusted unless `trusted`: the task starts tainted. */
    payload?: string;
    trusted?: boolean;
    /** It starts tainted: what started it had read untrusted content. */
    tainted?: boolean;
    /** Unset: the chat's effort. */
    effort?: "medium" | "high";
    message?: number;
    /** Your own recent chat messages, when you started it from the chat: what the approval check reads. */
    request?: string;
  }): Task | null {
    if (input.runKey && this.activeFor(input.runKey)) return null;
    const tainted = input.tainted || (input.payload !== undefined && !input.trusted);
    const id = this.insert({
      title: input.title,
      goal: input.goal,
      success_criteria: "",
      origin: input.origin,
      lane: "background",
      // Fixed for the task, like a desktop task's.
      model: this.d.settings.get().taskModel,
      effort: input.effort ?? null,
      source: input.source ?? null,
      schedule_id: input.scheduleId ?? null,
      trigger_id: input.triggerId ?? null,
      run_key: input.runKey ?? null,
      payload: input.payload ?? null,
      request: input.request ?? null,
      tainted: tainted ? 1 : 0,
    });
    if (input.origin === "chat" && !(input.message && this.d.thread.attachTask(input.message, id)))
      this.d.thread.addCard("task", `Task #${id}: ${input.title}`, { taskId: id });
    this.emit(id);
    this.start(id);
    return this.get(id) as Task;
  }

  private insert(row: Record<string, string | number | null>): number {
    const cols = {
      ...row,
      status: "queued",
      budget_usd: this.d.settings.get().limits.taskUsd,
      created_at: this.now(),
    };
    const names = Object.keys(cols);
    const id = this.d.db
      .query<{ id: number }, (string | number | null)[]>(
        `INSERT INTO tasks (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")}) RETURNING id`,
      )
      .get(...Object.values(cols))?.id;
    if (!id) throw new Error("task insert failed");
    return id;
  }

  /** What you said in the chat when you started it, or null. */
  requestOf(id: number): string | null {
    return (
      this.d.db
        .query<{ request: string | null }, [number]>("SELECT request FROM tasks WHERE id = ?")
        .get(id)?.request ?? null
    );
  }

  /** The unfinished task for a schedule, trigger or monitor. */
  activeFor(runKey: string): Task | null {
    const r = this.d.db
      .query<Row, [string]>(
        `${SELECT} WHERE t.run_key = ? AND t.status IN (${ACTIVE.map((s) => `'${s}'`).join(", ")}) ORDER BY t.id DESC LIMIT 1`,
      )
      .get(runKey);
    return r ? toTask(r) : null;
  }

  /** Resolves with the task once it has ended. */
  waitFor(id: number, signal: AbortSignal): Promise<Task> {
    return new Promise((resolve, reject) => {
      const ended = () => {
        const t = this.get(id);
        return t && FINAL.includes(t.status) ? t : null;
      };
      const done = ended();
      if (done) return resolve(done);
      if (signal.aborted) return reject(signal.reason);
      const off = this.d.events.on((e) => {
        if (e.type !== "task.updated" || e.task.id !== id) return;
        const t = ended();
        if (!t) return;
        stop();
        resolve(t);
      });
      const abort = () => {
        stop();
        reject(signal.reason);
      };
      const stop = () => {
        off();
        signal.removeEventListener("abort", abort);
      };
      signal.addEventListener("abort", abort, { once: true });
    });
  }

  /** What background tasks' tools need. */
  toolContext(): ToolContext {
    return {
      db: this.d.db,
      memory: this.d.memory,
      events: this.d.events,
      tasks: this,
      plugins: this.d.plugins,
    };
  }

  private start(id: number) {
    const abort = new AbortController();
    this.running.set(id, abort);
    const runner = this.get(id)?.lane === "background" ? runAgentTask : runDesktopTask;
    const run = runner(this, id, abort.signal)
      .catch((err) => console.error(`task ${id} crashed`, err))
      .finally(() => {
        this.running.delete(id);
        this.inbox.delete(id);
        this.runs.delete(run);
      });
    this.runs.add(run);
  }

  /** Waits for every run to end (tests, shutdown). */
  async idle() {
    while (this.runs.size) await Promise.all([...this.runs]);
  }

  emit(id: number) {
    const task = this.get(id);
    if (task) this.d.events.emit({ type: "task.updated", task });
  }

  setStatus(id: number, status: TaskStatus) {
    this.d.db
      .query(
        "UPDATE tasks SET status = ?, started_at = coalesce(started_at, CASE WHEN ? = 'running' THEN ? END) WHERE id = ?",
      )
      .run(status, status, this.now(), id);
    this.emit(id);
  }

  mark(id: number, flag: "tainted" | "injection_suspected") {
    this.d.db.query(`UPDATE tasks SET ${flag} = 1 WHERE id = ?`).run(id);
    this.emit(id);
  }

  budget(id: number): number {
    return this.d.db
      .query<{ budget_usd: number }, [number]>("SELECT budget_usd FROM tasks WHERE id = ?")
      .get(id)?.budget_usd as number;
  }

  raiseBudget(id: number, byUsd: number) {
    this.d.db.query("UPDATE tasks SET budget_usd = budget_usd + ? WHERE id = ?").run(byUsd, id);
  }

  addStep(
    taskId: number,
    step: Omit<TaskStep, "id" | "taskId" | "createdAt" | "screenshot"> & {
      screenshot?: string | null;
    },
  ): TaskStep {
    const row = this.d.db
      .query<TaskStep, [number, string, string, string, string | null, string | null, string]>(
        `INSERT INTO task_steps (task_id, kind, name, detail, screenshot, url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         RETURNING id, task_id AS taskId, kind, name, detail, screenshot, url, created_at AS createdAt`,
      )
      .get(
        taskId,
        step.kind,
        step.name,
        step.detail,
        step.screenshot ?? null,
        step.url,
        this.now(),
      );
    if (!row) throw new Error("step insert failed");
    this.d.events.emit({ type: "task.step", step: row });
    return row;
  }

  /** Tells a running task about something that happened, e.g. its monitor came back up. */
  tell(id: number, event: string) {
    this.inbox.set(id, [...(this.inbox.get(id) ?? []), event]);
  }

  /** What a task has been told since it last looked. */
  takeInbox(id: number): string[] {
    const events = this.inbox.get(id) ?? [];
    this.inbox.delete(id);
    return events;
  }

  setStepScreenshot(stepId: number, path: string) {
    const row = this.d.db
      .query<TaskStep, [string, number]>(
        `UPDATE task_steps SET screenshot = ? WHERE id = ?
         RETURNING id, task_id AS taskId, kind, name, detail, screenshot, url, created_at AS createdAt`,
      )
      .get(path, stepId);
    if (row) this.d.events.emit({ type: "task.step", step: row });
  }

  appendTurn(taskId: number, role: "user" | "assistant", content: unknown) {
    this.d.db
      .query("INSERT INTO task_turns (task_id, role, content, created_at) VALUES (?, ?, ?, ?)")
      .run(taskId, role, JSON.stringify(content), this.now());
  }

  /**
   * Ends a task: status, summary, the card's text, and a notification. A background task's card is
   * added now; with `notify` false (a routine result), a finished one gets neither card nor notification.
   */
  finish(id: number, status: "done" | "failed" | "cancelled", summary: string, notify = true) {
    this.d.db
      .query("UPDATE tasks SET status = ?, summary = ?, finished_at = ? WHERE id = ?")
      .run(status, summary, this.now(), id);
    const task = this.get(id);
    if (!task) return;
    const word = { done: "Done", failed: "Failed", cancelled: "Cancelled" }[status];
    const text = `Task #${id}: ${task.title}. ${word}: ${summary}`;
    // A desktop task run by a background task reports to it, not to you.
    const tell = !task.parentId && (notify || status === "failed");
    const card = this.d.db
      .query("UPDATE messages SET text = ? WHERE kind = 'task' AND task_id = ?")
      .run(text, id);
    // Shown under the reply that started it: its result shows there too.
    const underReply = this.d.db
      .query("SELECT 1 FROM messages WHERE kind = 'text' AND task_id = ?")
      .get(id);
    if (!card.changes && !underReply && tell && task.lane === "background")
      this.d.thread.addCard("task", text, { taskId: id });
    this.emit(id);
    if (!tell) return;
    void this.d.notifier.send({
      title: `${word}: ${task.title}`.slice(0, 120),
      message: summary || word,
      priority: status === "done" ? 3 : 4,
      click: `${this.d.config.publicUrl}/tasks/${id}`,
    });
  }

  cancel(id: number): boolean {
    const task = this.get(id);
    if (!task || FINAL.includes(task.status)) return false;
    this.running.get(id)?.abort(new Error("cancelled"));
    return true;
  }

  /** Pause all: stops every task (PLAN.md §6.5). */
  cancelAll() {
    for (const c of this.running.values()) c.abort(new Error("paused"));
  }

  /** Tasks shown in the thread (a card or under a reply) that ended since the thread last heard; marks them reported. */
  takeUnreported(): Task[] {
    const rows = this.d.db
      .query<Row, []>(
        `${SELECT} WHERE t.reported_at IS NULL AND t.status IN ('done', 'failed', 'cancelled')
         AND EXISTS (SELECT 1 FROM messages m WHERE m.kind IN ('task', 'text') AND m.task_id = t.id) ORDER BY t.id`,
      )
      .all();
    if (rows.length)
      this.d.db
        .query(`UPDATE tasks SET reported_at = ? WHERE id IN (${rows.map((r) => r.id).join(", ")})`)
        .run(this.now());
    return rows.map(toTask);
  }
}
