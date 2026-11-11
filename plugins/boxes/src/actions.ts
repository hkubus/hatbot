// Boxes' actions: one of the bot's scripts, with a fixed input, that the box's page runs with
// hatbox.action(name). The page's code may ask whenever it likes, so a run isn't proof you pressed
// anything: it's the script's own task, its changes following scripts' rules, a few a day.
import { PluginError } from "@hatbot/plugin-sdk";
import {
  ACTIVE_TASK_STATUSES,
  type BoxActionInfo,
  type BoxActionRun,
  type Script,
  type Task,
} from "@hatbot/shared";
import { BoxError, type Boxes } from "./boxes";
import type { Deps } from "./deps";

export const MAX_BOX_ACTIONS = 10;
export const ACTION_RUNS_PER_DAY = 20;
/** How long hatbox.action waits for its run to end before saying it's still going. */
const WAIT_MS = 30_000;

export const ACTION_MIGRATIONS = [
  `
  CREATE TABLE boxes_actions (
    id INTEGER PRIMARY KEY,
    box_id INTEGER NOT NULL REFERENCES boxes(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    script_id INTEGER NOT NULL,
    input TEXT NOT NULL,
    -- The script's writes when the action was added: one that changes more since doesn't run.
    writes TEXT NOT NULL,
    task_id INTEGER,
    created_at TEXT NOT NULL,
    UNIQUE (box_id, name)
  );
  CREATE TABLE boxes_action_runs (
    id INTEGER PRIMARY KEY,
    box_id INTEGER NOT NULL REFERENCES boxes(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL
  );
  CREATE INDEX boxes_action_runs_box ON boxes_action_runs (box_id, created_at);
  `,
];
export const ACTION_TABLES = ["boxes_actions", "boxes_action_runs"];

type Row = {
  id: number;
  box_id: number;
  name: string;
  script_id: number;
  input: string;
  writes: string;
  task_id: number | null;
  created_at: string;
};

const runOf = (t: Task): BoxActionRun => ({
  task: t.id,
  status: t.status,
  ...(t.summary ? { summary: t.summary } : {}),
  at: t.finishedAt ?? t.startedAt ?? t.createdAt,
});

export class BoxActions {
  constructor(
    private boxes: Boxes,
    private d: Pick<Deps, "db" | "settings" | "tasks" | "events" | "scripts" | "clock">,
  ) {}

  private now() {
    return new Date(this.d.clock()).toISOString();
  }

  private row(boxId: number, name: string): Row | null {
    return this.d.db
      .query<Row, [number, string]>("SELECT * FROM boxes_actions WHERE box_id = ? AND name = ?")
      .get(boxId, name);
  }

  private last(r: Row): BoxActionRun | undefined {
    const t = r.task_id === null ? null : this.d.tasks.get(r.task_id);
    return t ? runOf(t) : undefined;
  }

  list(boxId: number): BoxActionInfo[] {
    return this.d.db
      .query<Row, [number]>("SELECT * FROM boxes_actions WHERE box_id = ? ORDER BY name")
      .all(boxId)
      .map((r) => {
        const last = this.last(r);
        return {
          name: r.name,
          script: this.d.scripts()?.get(r.script_id)?.name ?? "(deleted)",
          input: JSON.parse(r.input),
          ...(last ? { last } : {}),
        };
      });
  }

  /** `botId`'s script that the action would run, or why it can't be added. */
  script(
    boxId: number,
    botId: string,
    a: { name: string; script: string; input: Record<string, unknown> },
  ): Script {
    const others =
      this.d.db
        .query<{ n: number }, [number, string]>(
          "SELECT count(*) AS n FROM boxes_actions WHERE box_id = ? AND name != ?",
        )
        .get(boxId, a.name)?.n ?? 0;
    if (others >= MAX_BOX_ACTIONS)
      throw new PluginError(`A box has at most ${MAX_BOX_ACTIONS} actions; remove one first.`);
    const scripts = this.d.scripts();
    if (!scripts) throw new PluginError("Scripts aren't running.");
    const s = scripts.byName(botId, a.script);
    if (!s) throw new PluginError(`You have no script called ${a.script}. See script_list.`);
    const unknown = Object.keys(a.input).filter((k) => !s.inputs.some((i) => i.name === k));
    if (unknown.length)
      throw new PluginError(`${s.name} has no input called ${unknown.join(", ")}.`);
    return s;
  }

  /** Adds the action, or changes the one with its name, with `s`'s writes as you approved them. */
  set(boxId: number, name: string, s: Script, input: Record<string, unknown>) {
    this.d.db
      .query(
        `INSERT INTO boxes_actions (box_id, name, script_id, input, writes, created_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (box_id, name) DO UPDATE SET script_id = excluded.script_id, input = excluded.input,
           writes = excluded.writes, task_id = NULL, created_at = excluded.created_at`,
      )
      .run(boxId, name, s.id, JSON.stringify(input), JSON.stringify(s.writes), this.now());
  }

  /** The bot's, or yours from the box's page. A run going on stays in Tasks. */
  remove(boxId: number, name: string): boolean {
    return (
      this.d.db.query("DELETE FROM boxes_actions WHERE box_id = ? AND name = ?").run(boxId, name)
        .changes > 0
    );
  }

  /** How its last run went, for the page; undefined before one. */
  check(boxId: number, name: string): BoxActionRun | undefined {
    const r = this.row(boxId, name);
    if (!r) throw new BoxError(`This box has no action "${name}".`, 404);
    return this.last(r);
  }

  /**
   * The box's page asked to run the action: its script starts as a task, and the answer comes once it
   * ends, or after a while with how it's going. Refused while paused, over the day's runs, while its
   * last run goes, or when its script changes more than it did when the action was added.
   */
  async press(boxId: number, name: string): Promise<BoxActionRun> {
    if (this.d.settings.get().paused) throw new BoxError("Hatbot is paused.", 409);
    const box = this.boxes.get(boxId);
    const r = this.row(boxId, name);
    if (!box || !r) throw new BoxError(`This box has no action "${name}".`, 404);
    const s = this.d.scripts()?.get(r.script_id);
    if (!s) throw new BoxError(`"${name}" can't run: its script was deleted.`, 409);
    if (!s.enabled) throw new BoxError(`"${name}" can't run: ${s.name} is switched off.`, 409);
    const approved = JSON.parse(r.writes) as string[];
    const more = s.writes.filter((w) => !approved.includes(w));
    if (more.length)
      throw new BoxError(
        `"${name}" can't run: ${s.name} now changes things with ${more.join(", ")}, which it didn't when the action was added.`,
        403,
      );
    const since = new Date(this.d.clock() - 86400_000).toISOString();
    const runs =
      this.d.db
        .query<{ n: number }, [number, string]>(
          "SELECT count(*) AS n FROM boxes_action_runs WHERE box_id = ? AND created_at > ?",
        )
        .get(boxId, since)?.n ?? 0;
    if (runs >= ACTION_RUNS_PER_DAY)
      throw new BoxError(`A box runs its actions at most ${ACTION_RUNS_PER_DAY} times a day.`, 429);
    const by = this.boxes.taintedBy(boxId);
    const task = this.d.scripts()?.start(s, {
      origin: "box",
      source: box.title,
      runKey: `box:${boxId}:${name}`,
      input: JSON.parse(r.input),
      // Otherwise the script's own taint, if it has one.
      ...(by ? { taintedBy: `Its box, whose page was written after reading: ${by}` } : {}),
    });
    if (!task) throw new BoxError(`"${name}" is still running.`, 429);
    this.d.db
      .query("INSERT INTO boxes_action_runs (box_id, created_at) VALUES (?, ?)")
      .run(boxId, this.now());
    this.d.db.query("UPDATE boxes_actions SET task_id = ? WHERE id = ?").run(task.id, r.id);
    return runOf(await this.ended(task.id));
  }

  /** The task once it ends, or as it is after WAIT_MS. */
  private ended(id: number): Promise<Task> {
    const now = () => this.d.tasks.get(id) as Task;
    const over = (t: Task) => !ACTIVE_TASK_STATUSES.includes(t.status);
    if (over(now())) return Promise.resolve(now());
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        off();
        resolve(now());
      };
      const timer = setTimeout(done, WAIT_MS);
      const off = this.d.events.on((e) => {
        if (e.type === "task.updated" && e.task.id === id && over(e.task)) done();
      });
    });
  }
}
