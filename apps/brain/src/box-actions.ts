// Boxes' actions (PLAN.md §21.16): a plugin tool with a fixed input that the bot declared and you
// approved once, which the box's page runs with hatbox.action(name). The page's code is code nobody
// read line by line, so a call from it isn't proof you pressed anything: each run follows the tool's
// own policy (allowed runs, asked asks you every time, blocked is refused), a few a day, none while
// paused.
import type { BoxActionAnswer, BoxActionInfo, BoxActionRun } from "@hatbot/shared";
import type { Chats } from "./agent/chats";
import type { Approvals, Outcome } from "./approvals";
import type { Bots } from "./bots";
import { BoxError, type Boxes } from "./boxes";
import type { Db } from "./db";
import type { PluginTool, Verdict } from "./plugins/plugin";
import { describeCall, type Plugins, runPluginTool, verdictFor } from "./plugins/registry";
import type { SettingsStore } from "./settings";

/** A box has at most this many actions, and its page runs them at most this often in a day. */
export const MAX_BOX_ACTIONS = 10;
export const ACTION_RUNS_PER_DAY = 20;
const TIMEOUT_MS = 60_000;

export type BoxAction = {
  name: string;
  tool: string;
  input: unknown;
  /** The last run: when it ended, what it answered, or why it failed or didn't run. */
  at: string | null;
  output: string | null;
  error: string | null;
};

type Row = {
  id: number;
  box_id: number;
  bot_id: string;
  name: string;
  tool: string;
  input: string;
  last_at: string | null;
  last_output: string | null;
  last_error: string | null;
};

/** A press in progress: running, or waiting for your approval. */
type Busy = { boxId: number; abort: AbortController; approvalId?: number };

const OUTCOME: Record<Exclude<Outcome, "approved">, string> = {
  denied: "You denied it.",
  expired: "Nobody answered within 24 hours.",
  cancelled: "Its approval was cancelled.",
};

export class BoxActions {
  private busy = new Map<number, Busy>();

  constructor(
    private d: {
      db: Db;
      settings: SettingsStore;
      plugins: Plugins;
      bots: Bots;
      approvals: Approvals;
      chats: Chats;
      boxes: Boxes;
      clock: () => number;
    },
  ) {}

  private now() {
    return new Date(this.d.clock()).toISOString();
  }

  private row(boxId: number, name: string): Row | null {
    return this.d.db
      .query<Row, [number, string]>("SELECT * FROM box_actions WHERE box_id = ? AND name = ?")
      .get(boxId, name);
  }

  list(boxId: number): BoxAction[] {
    return this.d.db
      .query<Row, [number]>("SELECT * FROM box_actions WHERE box_id = ? ORDER BY name")
      .all(boxId)
      .map((r) => ({
        name: r.name,
        tool: r.tool,
        input: JSON.parse(r.input),
        at: r.last_at,
        output: r.last_output,
        error: r.last_error,
      }));
  }

  /** For the box's page in the app: each action and what it runs, in a line. */
  info(boxId: number): BoxActionInfo[] {
    return this.d.db
      .query<Row, [number]>("SELECT * FROM box_actions WHERE box_id = ? ORDER BY name")
      .all(boxId)
      .map((r) => {
        const input = JSON.parse(r.input);
        const t = this.find(r.bot_id, r.tool);
        return { name: r.name, what: t ? describeCall(t, input) : `${r.tool} ${r.input}` };
      });
  }

  private find(botId: string, tool: string): PluginTool | undefined {
    const bot = this.d.bots.active(botId);
    return bot ? this.d.plugins.tools(bot.plugins).find((t) => t.name === tool) : undefined;
  }

  /**
   * The tool as it is now, if `botId` may run it with `input`, with what the call is in a line and
   * what its policy says of it now. BoxError says why not.
   */
  check(
    botId: string,
    tool: string,
    input: unknown,
  ): { t: PluginTool; what: string; verdict: Exclude<Verdict, { action: "block" }> } {
    const bot = this.d.bots.active(botId);
    if (!bot) throw new BoxError("The bot that added it was deleted.");
    const t = this.find(botId, tool);
    if (!t)
      throw new BoxError(
        `${bot.name} has no tool called ${tool}: its plugin is off, or not one ${bot.name} may use.`,
      );
    if (!t.schema.safeParse(input).success)
      throw new BoxError(`${t.name} doesn't take that input.`);
    const verdict = verdictFor(
      t,
      input,
      { task: null, signal: new AbortController().signal },
      false,
    );
    if (verdict.action === "block") throw new BoxError(`Refused: ${verdict.why}`, 403);
    return { t, what: describeCall(t, input), verdict };
  }

  /** Adds the action, or changes the one with its name; you approved it already. It doesn't run. */
  set(boxId: number, botId: string, a: { name: string; tool: string; input: unknown }) {
    const count =
      this.d.db
        .query<{ n: number }, [number, string]>(
          "SELECT count(*) AS n FROM box_actions WHERE box_id = ? AND name != ?",
        )
        .get(boxId, a.name)?.n ?? 0;
    if (count >= MAX_BOX_ACTIONS)
      throw new BoxError(`A box has at most ${MAX_BOX_ACTIONS} actions; remove one first.`);
    this.check(botId, a.tool, a.input);
    const old = this.row(boxId, a.name);
    if (old) this.drop(old.id);
    this.d.db
      .query(
        `INSERT INTO box_actions (box_id, bot_id, name, tool, input, created_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (box_id, name) DO UPDATE SET bot_id = excluded.bot_id, tool = excluded.tool,
           input = excluded.input, created_at = excluded.created_at, last_at = NULL,
           last_output = NULL, last_error = NULL`,
      )
      .run(boxId, botId, a.name, a.tool, JSON.stringify(a.input), this.now());
  }

  /** The bot's, or yours from the box's page: a run waiting for approval goes with it. */
  remove(boxId: number, name: string): boolean {
    const r = this.row(boxId, name);
    if (!r) return false;
    this.drop(r.id);
    this.d.db.query("DELETE FROM box_actions WHERE id = ?").run(r.id);
    return true;
  }

  /** Stops what a press of the action is doing: its run, or its approval. */
  private drop(id: number, why = "the action was changed or removed.") {
    const b = this.busy.get(id);
    if (!b) return;
    this.busy.delete(id);
    b.abort.abort(why);
    if (b.approvalId !== undefined) this.d.approvals.cancel(b.approvalId);
  }

  /** The box was deleted. */
  forget(boxId: number) {
    for (const [id, b] of this.busy) if (b.boxId === boxId) this.drop(id, "the box was deleted.");
  }

  /** Pause all: stops every run, and cancels the approvals presses wait for. */
  stopAll() {
    for (const id of [...this.busy.keys()]) this.drop(id, "Hatbot was paused.");
  }

  /** How the action's last run went, for the page; null for an action the box hasn't got. */
  last(boxId: number, name: string): BoxActionRun | null {
    const r = this.row(boxId, name);
    if (!r) return null;
    const waiting = this.busy.get(r.id)?.approvalId !== undefined;
    if (!r.last_at && !waiting) return null;
    return {
      at: r.last_at,
      ...(r.last_output !== null ? { output: r.last_output } : {}),
      ...(r.last_error !== null ? { error: r.last_error } : {}),
      ...(waiting ? { waiting: true as const } : {}),
    };
  }

  /**
   * The box's page asked to run the action: it runs now when the tool's policy allows it, or asks you
   * and runs once you approve. Refused (BoxError) while paused, over the limits, or when it can't run
   * as it is.
   */
  async press(boxId: number, name: string): Promise<BoxActionAnswer> {
    if (this.d.settings.get().paused) throw new BoxError("Hatbot is paused.", 409);
    const r = this.row(boxId, name);
    if (!r) throw new BoxError(`This box has no action "${name}".`, 404);
    if (this.busy.has(r.id))
      throw new BoxError(`"${name}" is already running or waiting for your approval.`, 429);
    const since = new Date(this.d.clock() - 86400_000).toISOString();
    const runs =
      this.d.db
        .query<{ n: number }, [number, string]>(
          "SELECT count(*) AS n FROM box_action_runs WHERE box_id = ? AND created_at > ?",
        )
        .get(boxId, since)?.n ?? 0;
    if (runs >= ACTION_RUNS_PER_DAY)
      throw new BoxError(`A box runs its actions at most ${ACTION_RUNS_PER_DAY} times a day.`, 429);
    const input = JSON.parse(r.input);
    // The tool's own policy decides; your approval when it was added stands in for the
    // untrusted-content rule, since the bot can't change what it runs.
    const { t, what, verdict } = this.check(r.bot_id, r.tool, input);
    const run = this.d.db
      .query<{ id: number }, [number, string]>(
        "INSERT INTO box_action_runs (box_id, created_at) VALUES (?, ?) RETURNING id",
      )
      .get(boxId, this.now())?.id as number;
    const busy: Busy = { boxId, abort: new AbortController() };
    this.busy.set(r.id, busy);
    if (verdict.action === "allow") {
      try {
        return await this.run(r, run, t, input, what, busy);
      } finally {
        if (this.busy.get(r.id) === busy) this.busy.delete(r.id);
      }
    }
    const box = this.d.boxes.get(boxId);
    const approval = this.d.approvals.create({
      taskId: null,
      botId: r.bot_id,
      kind: verdict.kind ?? t.kind ?? "other",
      summary: `Box #${boxId} "${box?.title ?? ""}", action "${name}": ${what}`,
      reason: `${verdict.why} The box's page asked for it; its code can ask whenever it likes, so this isn't proof you pressed anything.`,
    });
    busy.approvalId = approval.id;
    void this.afterApproval(r, run, t, input, what, busy, approval.id);
    return { status: "asked" };
  }

  private async afterApproval(
    r: Row,
    run: number,
    t: PluginTool,
    input: unknown,
    what: string,
    busy: Busy,
    approvalId: number,
  ) {
    try {
      let outcome: Outcome;
      try {
        outcome = await this.d.approvals.wait(approvalId, busy.abort.signal);
      } catch {
        outcome = "cancelled";
      }
      // Removed, changed or its box deleted meanwhile: nothing of it is left to run or to tell.
      if (this.busy.get(r.id) !== busy && outcome === "approved") return;
      const paused = this.d.settings.get().paused;
      if (outcome !== "approved")
        return this.record(r, run, what, {
          error: `Not run: ${outcome === "cancelled" && paused ? "Hatbot is paused." : OUTCOME[outcome]}`,
        });
      if (paused) return this.record(r, run, what, { error: "Not run: Hatbot is paused." });
      // What you approved was the tool as it was: one switched off or restarted meanwhile doesn't run.
      if (this.find(r.bot_id, r.tool) !== t)
        return this.record(r, run, what, {
          error: `Not run: ${t.name}'s plugin was switched off or restarted while it waited for your approval.`,
        });
      busy.approvalId = undefined;
      await this.run(r, run, t, input, what, busy);
    } catch (err) {
      console.error(`box ${r.box_id}: action ${r.name} failed`, err);
    } finally {
      if (this.busy.get(r.id) === busy) this.busy.delete(r.id);
    }
  }

  private async run(
    r: Row,
    run: number,
    t: PluginTool,
    input: unknown,
    what: string,
    busy: Busy,
  ): Promise<BoxActionAnswer> {
    const signal = AbortSignal.any([busy.abort.signal, AbortSignal.timeout(TIMEOUT_MS)]);
    let out: { text: string; isError: boolean };
    try {
      out = await runPluginTool(t, input, { task: null, signal });
    } catch (err) {
      if (!signal.aborted) throw err;
      out = {
        text: `Stopped: ${busy.abort.signal.aborted ? busy.abort.signal.reason : "it took more than a minute."}`,
        isError: true,
      };
    }
    // runPluginTool cuts it to what a tool result keeps.
    const output = out.text;
    this.record(r, run, what, out.isError ? { error: output } : { output });
    return { status: "done", output, ok: !out.isError };
  }

  /**
   * Keeps how the run went, unless the action changed meanwhile, and leaves a note in the box's chat,
   * untrusted like its others: the page chose when to run it. Not the output, which the page has.
   */
  private record(r: Row, run: number, what: string, end: { output?: string; error?: string }) {
    const kept = this.d.db
      .query(
        `UPDATE box_actions SET last_at = ?, last_output = ?, last_error = ?
         WHERE id = ? AND tool = ? AND input = ?`,
      )
      .run(this.now(), end.output ?? null, end.error ?? null, r.id, r.tool, r.input).changes;
    const box = this.d.boxes.get(r.box_id);
    if (!kept || !box) return;
    const call = what.replace(/\.$/, "");
    const ran = end.error?.startsWith("Not run: ")
      ? `Didn't run ${r.name}: ${call}. ${end.error.slice("Not run: ".length)}`
      : `Ran ${r.name}: ${call}. ${end.error ? "It failed." : "It worked."}`;
    const note = this.d.chats.boxNote(box, ran);
    this.d.db.query("UPDATE box_action_runs SET message_id = ? WHERE id = ?").run(note.id, run);
  }
}
