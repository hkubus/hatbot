// Tasks (PLAN.md §5.1): storage, cards in the thread, the timeline, and starting runs.
import {
  type ACTIVE_TASK_STATUSES,
  type Bot,
  HATBOT_ID,
  type Task,
  type TaskStatus,
  type TaskStep,
} from "@hatbot/shared";
import type { Chats } from "../agent/chats";
import type { ModelClient } from "../agent/model";
import type { ToolContext } from "../agent/tools";
import type { Approvals } from "../approvals";
import type { Archive } from "../archive";
import type { Attachments } from "../attachments";
import type { Bots } from "../bots";
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
  /** Files tasks send the owner. */
  attachments?: Attachments;
  chats: Chats;
  bots: Bots;
  config: Config;
  memory: MemoryStore;
  plugins: Plugins;
  skills: Skills;
  clock?: () => number;
};

/** Background tasks at once (PLAN.md §5.6). */
const BACKGROUND_SLOTS = 3;
/** Bots handing work to bots that hand it on: at most this many in a row. */
export const MAX_HANDOFFS = 3;

type Row = {
  id: number;
  bot_id: string;
  conversation_id: number | null;
  requested_by: string | null;
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
  tainted_by: string | null;
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
  botId: r.bot_id,
  requestedBy: r.requested_by,
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
  taintedBy: r.tainted_by,
  injectionSuspected: Boolean(r.injection_suspected),
  summary: r.summary,
  costUsd: r.cost_usd ?? 0,
  steps: r.steps,
  createdAt: r.created_at,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
});

/** Ended tasks shown in a chat that its bot hasn't heard about: a chat's id, then a bot's. */
const UNREPORTED = `t.reported_at IS NULL AND t.status IN ('done', 'failed', 'cancelled')
  AND coalesce(t.conversation_id, 1) = ? AND coalesce(t.requested_by, t.bot_id) = ?
  AND EXISTS (SELECT 1 FROM messages m WHERE m.kind IN ('task', 'text', 'command') AND m.task_id = t.id)`;

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
  /** Wakes a task waiting for its inbox. */
  private wakers = new Map<number, () => void>();
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
    /** The bot doing it; a parent task's, or Hatbot. */
    botId?: string;
    /** The chat it reports to; the bot's own by default. */
    conversationId?: number;
  }): Task {
    const p = input.parent;
    const botId = input.botId ?? p?.botId ?? HATBOT_ID;
    const conversationId = input.conversationId ?? this.conversationOf(p?.id) ?? this.home(botId);
    const id = this.insert({
      bot_id: botId,
      conversation_id: conversationId,
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
    if (!p && !(input.message && this.d.chats.attachTask(input.message, id)))
      this.d.chats.addCard(conversationId, botId, "task", `Task #${id}: ${input.title}`, {
        taskId: id,
      });
    this.emit(id);
    this.start(id);
    return this.get(id) as Task;
  }

  /** A bot's own chat. */
  private home(botId: string): number {
    return this.d.chats.direct(botId).conversationId;
  }

  /** The chat a task reports to. */
  private conversationOf(id: number | undefined): number | null {
    if (id === undefined) return null;
    return (
      this.d.db
        .query<{ conversation_id: number | null }, [number]>(
          "SELECT conversation_id FROM tasks WHERE id = ?",
        )
        .get(id)?.conversation_id ?? null
    );
  }

  /** The bot doing a task. */
  botOf(task: Task): Bot {
    return this.d.bots.get(task.botId) ?? this.d.bots.hatbot();
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
    /** It starts tainted: what started it had read untrusted content, this. */
    taintedBy?: string | null;
    /** Unset: the chat's effort. */
    effort?: "medium" | "high";
    message?: number;
    /** Your own recent chat messages, when you started it from the chat: what the approval check reads. */
    request?: string;
    /** The bot doing it; Hatbot by default. */
    botId?: string;
    /** The chat it reports to; the bot's own by default. */
    conversationId?: number;
    /** The bot that handed it over (ask_bot), which hears how it ended. */
    requestedBy?: string;
    /** The task that handed it over, which waits for it; it shows nowhere in the chat. */
    parent?: Task;
  }): Task | null {
    if (input.runKey && this.activeFor(input.runKey)) return null;
    const taintedBy =
      input.taintedBy ||
      (input.payload !== undefined && !input.trusted
        ? `The event that started it (${input.source ?? input.origin})`
        : null);
    const botId = input.botId ?? HATBOT_ID;
    const conversationId =
      input.conversationId ?? this.conversationOf(input.parent?.id) ?? this.home(botId);
    const id = this.insert({
      bot_id: botId,
      conversation_id: conversationId,
      requested_by: input.requestedBy ?? null,
      parent_id: input.parent?.id ?? null,
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
      tainted: taintedBy ? 1 : 0,
      tainted_by: taintedBy,
    });
    if (
      input.origin === "chat" &&
      !input.parent &&
      !(input.message && this.d.chats.attachTask(input.message, id))
    )
      this.d.chats.addCard(
        conversationId,
        input.requestedBy ?? botId,
        "task",
        `Task #${id}: ${input.title}`,
        {
          taskId: id,
        },
      );
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

  /** How many hand-offs between bots led to this task, its own included. */
  handoffs(task: Task | null): number {
    let n = 0;
    for (let t = task; t; t = t.parentId ? this.get(t.parentId) : null) if (t.requestedBy) n++;
    return n;
  }

  /**
   * ask_bot: another bot works on `request` as its own task, with what the asker had read. From the
   * chat it shows under the asker's reply (`message`), and the asker hears how it ended; from a task
   * (`parent`), that task waits for it. A string says why it couldn't start.
   */
  askBot(input: {
    from: Bot;
    to: string;
    request: string;
    conversationId?: number;
    message?: number;
    parent?: Task;
    taintedBy: string | null;
    ownerSaid?: string;
  }): Task | string {
    const want = input.to.trim().toLowerCase();
    const to = this.d.bots.list().find((b) => b.id === want || b.name.toLowerCase() === want);
    if (!to) {
      const names = this.d.bots
        .list()
        .filter((b) => b.id !== input.from.id)
        .map((b) => b.name);
      return `There's no bot called "${input.to}". The owner's other bots: ${names.join(", ") || "none"}.`;
    }
    if (to.id === input.from.id)
      return "That's you. Do it yourself, or start a task with run_task.";
    if (this.handoffs(input.parent ?? null) >= MAX_HANDOFFS)
      return `Hand-offs between bots go at most ${MAX_HANDOFFS} deep, and this would be deeper. Do it yourself, or report what you have.`;
    const firstLine = input.request.trim().split("\n")[0] ?? "";
    const task = this.createBackgroundTask({
      title: firstLine.length > 80 ? `${firstLine.slice(0, 79)}…` : firstLine,
      goal: input.request,
      origin: input.parent?.origin ?? "chat",
      source: input.parent?.source ?? undefined,
      botId: to.id,
      conversationId: input.conversationId,
      requestedBy: input.from.id,
      parent: input.parent,
      message: input.message,
      taintedBy: input.taintedBy,
      request: input.ownerSaid,
    });
    return task ?? "The task couldn't start.";
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

  /** What a background task's tools need. */
  toolContext(task: Task): ToolContext {
    return {
      db: this.d.db,
      memory: this.d.memory,
      events: this.d.events,
      bot: this.botOf(task),
      bots: this.d.bots,
      tasks: this,
      plugins: this.d.plugins,
      attachments: this.d.attachments,
      desktop: this.d.desktop.agent,
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

  mark(id: number, flag: "injection_suspected") {
    this.d.db.query(`UPDATE tasks SET ${flag} = 1 WHERE id = ?`).run(id);
    this.emit(id);
  }

  /** It has read untrusted content; `by` is what, kept only the first time. */
  taint(id: number, by: string) {
    this.d.db
      .query("UPDATE tasks SET tainted = 1, tainted_by = coalesce(tainted_by, ?) WHERE id = ?")
      .run(by, id);
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
    this.wakers.get(id)?.();
  }

  /**
   * Waits up to `ms` for a task to be told something. True if it was (or already had been), false
   * when the time ran out.
   */
  nextEvent(id: number, ms: number, signal: AbortSignal): Promise<boolean> {
    if (this.inbox.get(id)?.length) return Promise.resolve(true);
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const end = (fn: () => void) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        this.wakers.delete(id);
        fn();
      };
      const timer = setTimeout(() => end(() => resolve(false)), ms);
      const abort = () => end(() => reject(signal.reason));
      signal.addEventListener("abort", abort, { once: true });
      this.wakers.set(id, () => end(() => resolve(true)));
    });
  }

  /** A notification from a running task, before it ends: for news the owner shouldn't wait for. */
  notifyOwner(id: number, message: string) {
    const task = this.get(id);
    if (!task) return;
    void this.d.notifier.send({
      title: this.titled(task, task.title),
      message,
      priority: 4,
      click: `${this.d.config.publicUrl}/tasks/${id}`,
    });
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
      .query("SELECT 1 FROM messages WHERE kind IN ('text', 'command') AND task_id = ?")
      .get(id);
    if (card.changes || underReply) this.d.chats.markEdited(id);
    // The bot that asked for it tells you, in the chat it was started from.
    const reporter = task.requestedBy ?? task.botId;
    const conversationId = this.conversationOf(id) ?? this.home(reporter);
    // Started from the chat: the chat model hears now and answers, with the conversation in mind. A
    // bot that asked another always passes on what came of it.
    const asked = !task.parentId && task.requestedBy !== null;
    if (underReply && (tell || asked) && status !== "cancelled")
      void this.d.chats.taskEnded(conversationId, reporter);
    else if (tell && task.lane === "background")
      this.d.chats.addCard(conversationId, reporter, "task", text, { taskId: id });
    this.emit(id);
    if (!tell) return;
    void this.d.notifier.send({
      title: this.titled(task, `${word}: ${task.title}`),
      message: summary || word,
      priority: status === "done" ? 3 : 4,
      click: `${this.d.config.publicUrl}/tasks/${id}`,
    });
  }

  /** A notification's title: another bot's says which. */
  titled(task: Task, title: string): string {
    const named = task.botId === HATBOT_ID ? title : `${this.d.bots.nameOf(task.botId)} · ${title}`;
    return named.slice(0, 120);
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

  /** Whether takeUnreported has anything for this chat and bot. */
  hasUnreported(conversationId: number, botId: string): boolean {
    return !!this.d.db
      .query<unknown, [number, string]>(`SELECT 1 FROM tasks t WHERE ${UNREPORTED}`)
      .get(conversationId, botId);
  }

  /**
   * Tasks shown in a chat (a card or under a reply) that ended since `botId`, which started or asked
   * for them, last heard; marks them reported.
   */
  takeUnreported(conversationId: number, botId: string): Task[] {
    const rows = this.d.db
      .query<Row, [number, string]>(`${SELECT} WHERE ${UNREPORTED} ORDER BY t.id`)
      .all(conversationId, botId);
    if (rows.length)
      this.d.db
        .query(`UPDATE tasks SET reported_at = ? WHERE id IN (${rows.map((r) => r.id).join(", ")})`)
        .run(this.now());
    return rows.map(toTask);
  }
}
