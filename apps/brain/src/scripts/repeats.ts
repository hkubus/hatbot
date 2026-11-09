// The calls a bot's replies made, to notice when it does the same for you again: then it offers to
// save them as a script.

import { stepsIn } from "@hatbot/shared";
import type { Db } from "../db";
import type { ScriptStore } from "./store";

const WINDOW_MS = 30 * 86400_000;
/** Replies before this one that made the same calls. */
const SEEN = 2;
const MIN_CALLS = 2;

/** One after another of the same tool counts once: a reply that reads three VMs read VMs. */
export function callsKey(calls: string[]): string {
  return calls.filter((c, i) => c !== calls[i - 1]).join(" ");
}

export class Repeats {
  constructor(
    private db: Db,
    private scripts: ScriptStore,
    private clock: () => number,
  ) {}

  private since() {
    return new Date(this.clock() - WINDOW_MS).toISOString();
  }

  record(botId: string, calls: string[]) {
    const key = callsKey(calls);
    if (key.split(" ").length < MIN_CALLS) return;
    this.db
      .query("INSERT INTO reply_calls (bot_id, calls, at) VALUES (?, ?, ?)")
      .run(botId, key, new Date(this.clock()).toISOString());
    this.db.query("DELETE FROM reply_calls WHERE at < ?").run(this.since());
  }

  /** What to tell the bot, once, when this reply's calls so far are ones it has made before. */
  offer(botId: string, calls: string[]): string | null {
    const key = callsKey(calls);
    const tools = key.split(" ");
    if (tools.length < MIN_CALLS) return null;
    const rows = this.db
      .query<{ n: number; offered: number }, [string, string, string]>(
        "SELECT count(*) AS n, max(offered) AS offered FROM reply_calls WHERE bot_id = ? AND calls = ? AND at >= ?",
      )
      .get(botId, key, this.since());
    if (!rows || rows.n < SEEN || rows.offered) return null;
    const scripted = this.scripts.list(botId).some((s) => {
      const used = [...stepsIn(s.steps)].flatMap(([x]) => ("call" in x ? [x.call] : []));
      return callsKey(used) === key;
    });
    this.db
      .query("UPDATE reply_calls SET offered = 1 WHERE bot_id = ? AND calls = ?")
      .run(botId, key);
    if (scripted) return null;
    return `(No message from the owner: the app noticed you've made these same calls for the owner ${rows.n + 1} times in the last 30 days: ${tools.join(", ")}. Answer as usual, then offer in a sentence to save it as a script, which runs those steps without a model whenever they ask, or on a schedule or a watcher. Save it with script_save (find it with tool_search_tool_regex "script_") only if they say yes, with what changes from one time to the next as its inputs.)`;
  }
}
