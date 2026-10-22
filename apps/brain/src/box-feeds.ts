// A plugin's read tool the brain runs for a box's page on a timer, without the model.
import { type BoxFeedValue, MAX_BOX_VALUE } from "@hatbot/shared";
import type { Bots } from "./bots";
import { BoxError } from "./boxes";
import type { Db } from "./db";
import { PluginError } from "./plugins/plugin";
import type { Plugins } from "./plugins/registry";
import type { SettingsStore } from "./settings";

export const MAX_BOX_FEEDS = 10;
const PARALLEL = 4;

/** The feed can never run as it is: it stops until its bot adds it again. */
class Stopped extends BoxError {}

export type BoxFeed = {
  name: string;
  tool: string;
  input: unknown;
  everyMinutes: number;
  value: unknown;
  at: string | null;
  error: string | null;
  stopped: boolean;
};

type Row = {
  id: number;
  box_id: number;
  bot_id: string;
  name: string;
  tool: string;
  input: string;
  every_minutes: number;
  value: string | null;
  value_at: string | null;
  error: string | null;
  next_run_at: string | null;
};

const toFeed = (r: Row): BoxFeed => ({
  name: r.name,
  tool: r.tool,
  input: JSON.parse(r.input),
  everyMinutes: r.every_minutes,
  value: r.value === null ? null : JSON.parse(r.value),
  at: r.value_at,
  error: r.error,
  stopped: r.next_run_at === null,
});

function parsed(out: string): unknown {
  if (!/^\s*[[{]/.test(out)) return out;
  try {
    return JSON.parse(out);
  } catch {
    return out;
  }
}

export class BoxFeeds {
  private running = new Set<number>();

  constructor(
    private d: {
      db: Db;
      settings: SettingsStore;
      plugins: Plugins;
      bots: Bots;
      clock: () => number;
    },
  ) {}

  private now() {
    return new Date(this.d.clock()).toISOString();
  }

  private after(minutes: number) {
    return new Date(this.d.clock() + minutes * 60_000).toISOString();
  }

  private row(boxId: number, name: string): Row | null {
    return this.d.db
      .query<Row, [number, string]>("SELECT * FROM box_feeds WHERE box_id = ? AND name = ?")
      .get(boxId, name);
  }

  list(boxId: number): BoxFeed[] {
    return this.d.db
      .query<Row, [number]>("SELECT * FROM box_feeds WHERE box_id = ? ORDER BY name")
      .all(boxId)
      .map(toFeed);
  }

  latest(boxId: number, name: string): BoxFeedValue | null {
    const r = this.row(boxId, name);
    if (!r?.value_at) return null;
    const f = toFeed(r);
    return { value: f.value, at: r.value_at, ...(f.error ? { error: f.error } : {}) };
  }

  async set(
    boxId: number,
    botId: string,
    f: { name: string; tool: string; input: unknown; everyMinutes: number },
  ): Promise<BoxFeedValue> {
    const count =
      this.d.db
        .query<{ n: number }, [number, string]>(
          "SELECT count(*) AS n FROM box_feeds WHERE box_id = ? AND name != ?",
        )
        .get(boxId, f.name)?.n ?? 0;
    if (count >= MAX_BOX_FEEDS)
      throw new BoxError(`A box has at most ${MAX_BOX_FEEDS} feeds; remove one first.`);
    const value = await this.read(botId, f.tool, f.input);
    const now = this.now();
    this.d.db
      .query(
        `INSERT INTO box_feeds (box_id, bot_id, name, tool, input, every_minutes, value, value_at, next_run_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (box_id, name) DO UPDATE SET bot_id = excluded.bot_id, tool = excluded.tool,
           input = excluded.input, every_minutes = excluded.every_minutes, value = excluded.value,
           value_at = excluded.value_at, error = NULL, next_run_at = excluded.next_run_at`,
      )
      .run(
        boxId,
        botId,
        f.name,
        f.tool,
        JSON.stringify(f.input),
        f.everyMinutes,
        JSON.stringify(value),
        now,
        this.after(f.everyMinutes),
        now,
      );
    return { value, at: now };
  }

  remove(boxId: number, name: string): boolean {
    return (
      this.d.db.query("DELETE FROM box_feeds WHERE box_id = ? AND name = ?").run(boxId, name)
        .changes > 0
    );
  }

  async tick(): Promise<void> {
    if (this.d.settings.get().paused) return;
    const due = this.d.db
      .query<Row, [string]>(
        "SELECT * FROM box_feeds WHERE next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at",
      )
      .all(this.now())
      .filter((r) => !this.running.has(r.id))
      .slice(0, Math.max(0, PARALLEL - this.running.size));
    await Promise.all(due.map((r) => this.run(r)));
  }

  private async run(r: Row) {
    this.running.add(r.id);
    const { db } = this.d;
    // Only the feed as it was read: one changed meanwhile keeps its new self.
    const same = "WHERE id = ? AND tool = ? AND input = ?";
    try {
      // The next run counts from this one, so an outage doesn't queue up a run per missed time.
      db.query(`UPDATE box_feeds SET next_run_at = ? ${same} AND next_run_at IS NOT NULL`).run(
        this.after(r.every_minutes),
        r.id,
        r.tool,
        r.input,
      );
      try {
        const value = await this.read(r.bot_id, r.tool, JSON.parse(r.input));
        db.query(`UPDATE box_feeds SET value = ?, value_at = ?, error = NULL ${same}`).run(
          JSON.stringify(value),
          this.now(),
          r.id,
          r.tool,
          r.input,
        );
      } catch (err) {
        if (!(err instanceof BoxError)) console.error(`box feed ${r.id} failed`, err);
        const stop = err instanceof Stopped;
        const why = err instanceof BoxError ? err.message : "It failed; see the brain's log.";
        // A failed run keeps the last result; a stopped feed keeps it too, saying why it's old.
        db.query(
          `UPDATE box_feeds SET error = ?, next_run_at = CASE WHEN ? THEN NULL ELSE next_run_at END ${same}`,
        ).run(stop ? `Stopped: ${why}` : why, stop ? 1 : 0, r.id, r.tool, r.input);
      }
    } finally {
      this.running.delete(r.id);
    }
  }

  private async read(botId: string, tool: string, input: unknown): Promise<unknown> {
    const bot = this.d.bots.active(botId);
    if (!bot) throw new Stopped("The bot that added it was deleted.");
    const t = this.d.plugins.tools(bot.plugins).find((x) => x.name === tool);
    if (!t) {
      const plugin = this.d.plugins.pluginOf(tool);
      const state = plugin && this.d.plugins.get(plugin.id)?.state;
      // Starting, or failing for now: it may be back by the next run.
      if (plugin && (state === "starting" || state === "error"))
        throw new BoxError(`${plugin.name} isn't ready.`);
      throw new Stopped(
        `${bot.name} has no tool called ${tool}: its plugin is off, or not one ${bot.name} may use.`,
      );
    }
    if (t.access !== "read") throw new Stopped(`${t.name} changes things; feeds only read.`);
    const ok = t.schema.safeParse(input ?? {});
    if (!ok.success) throw new Stopped(`${t.name} doesn't take that input.`);
    let out: string;
    try {
      out = await t.run(ok.data, {
        task: null,
        signal: AbortSignal.timeout(60_000),
        feed: true,
      });
    } catch (err) {
      if (err instanceof PluginError) throw new BoxError(err.message);
      throw err;
    }
    if (Buffer.byteLength(out) > MAX_BOX_VALUE)
      throw new BoxError(`${t.name} answered with more than the 1 MB a feed keeps.`);
    return parsed(out);
  }
}
