// Tasks (PLAN.md §5.1): storage, cards in the thread, the timeline, and starting runs.
import type { ACTIVE_TASK_STATUSES, Task, TaskStatus, TaskStep } from "@hatbot/shared";
import type { ModelClient } from "../agent/model";
import type { Thread } from "../agent/thread";
import type { Approvals } from "../approvals";
import type { Archive } from "../archive";
import type { Config } from "../config";
import type { Db } from "../db";
import type { Desktop } from "../desktop/service";
import type { EventBus } from "../events";
import type { Notifier } from "../notify";
import type { SettingsStore } from "../settings";
import type { Spend } from "../spend";
import { DESKTOP_MODEL, runDesktopTask } from "./desktop-run";
import { ScreenLane } from "./lane";

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
  clock?: () => number;
};

type Row = {
  id: number;
  title: string;
  goal: string;
  success_criteria: string;
  origin: Task["origin"];
  lane: Task["lane"];
  model: string;
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
  model: r.model,
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
  private running = new Map<number, AbortController>();
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

  list(opts: { status?: "active" | "done"; limit?: number } = {}): Task[] {
    const where =
      opts.status === "active"
        ? `WHERE t.status IN (${ACTIVE.map((s) => `'${s}'`).join(", ")})`
        : opts.status === "done"
          ? `WHERE t.status IN (${FINAL.map((s) => `'${s}'`).join(", ")})`
          : "";
    return this.d.db
      .query<Row, [number]>(`${SELECT} ${where} ORDER BY t.id DESC LIMIT ?`)
      .all(opts.limit ?? 50)
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

  /** Starts a desktop task: a card in the thread, then a run that waits for the screen lane. */
  createDesktopTask(input: {
    title: string;
    goal: string;
    successCriteria: string;
    origin: Task["origin"];
  }): Task {
    const row = this.d.db
      .query<{ id: number }, [string, string, string, string, string, number, string]>(
        `INSERT INTO tasks (title, goal, success_criteria, origin, lane, model, status, budget_usd, created_at)
         VALUES (?, ?, ?, ?, 'screen', ?, 'queued', ?, ?) RETURNING id`,
      )
      .get(
        input.title,
        input.goal,
        input.successCriteria,
        input.origin,
        DESKTOP_MODEL,
        this.d.settings.get().limits.taskUsd,
        this.now(),
      );
    const id = row?.id ?? -1;
    this.d.thread.addCard("task", `Task #${id}: ${input.title}`, { taskId: id });
    this.emit(id);
    this.start(id);
    return this.get(id) as Task;
  }

  private start(id: number) {
    const abort = new AbortController();
    this.running.set(id, abort);
    const run = runDesktopTask(this, id, abort.signal)
      .catch((err) => console.error(`task ${id} crashed`, err))
      .finally(() => {
        this.running.delete(id);
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

  /** Ends a task: status, summary, the card's text, and a notification. */
  finish(id: number, status: "done" | "failed" | "cancelled", summary: string) {
    this.d.db
      .query("UPDATE tasks SET status = ?, summary = ?, finished_at = ? WHERE id = ?")
      .run(status, summary, this.now(), id);
    const task = this.get(id);
    if (!task) return;
    const word = { done: "Done", failed: "Failed", cancelled: "Cancelled" }[status];
    this.d.db
      .query("UPDATE messages SET text = ? WHERE kind = 'task' AND task_id = ?")
      .run(`Task #${id}: ${task.title}. ${word}: ${summary}`, id);
    this.emit(id);
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

  /** Tasks from chat that ended since the thread last heard; marks them reported. */
  takeUnreported(): Task[] {
    const rows = this.d.db
      .query<Row, []>(
        `${SELECT} WHERE t.origin = 'chat' AND t.reported_at IS NULL AND t.status IN ('done', 'failed', 'cancelled') ORDER BY t.id`,
      )
      .all();
    if (rows.length)
      this.d.db
        .query(`UPDATE tasks SET reported_at = ? WHERE id IN (${rows.map((r) => r.id).join(", ")})`)
        .run(this.now());
    return rows.map(toTask);
  }
}
