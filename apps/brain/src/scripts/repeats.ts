// The calls a bot's replies, and its schedules' runs, made, to notice when it does the same again: then
// it offers to save them as a script. And the checks the owner asks a bot for: asked on several days,
// it offers a schedule.

import { localStamp, untrustedBlock } from "@hatbot/plugin-sdk";
import { stepsIn, type Task } from "@hatbot/shared";
import { tagText } from "../agent/untrusted";
import type { Db } from "../db";
import type { ScriptStore } from "./store";

const WINDOW_MS = 30 * 86400_000;
/** Replies or runs before this one that made the same calls. */
const SEEN = 2;
const INPUT_CHARS = 600;
const CALLS_CHARS = 6000;
/** Days the owner asked for the same check on before a schedule is offered. */
const CHECK_DAYS = 3;
const KNOWN_CHECKS = 30;
const SHOWN_ASKS = 12;
/** The owner's local day, as their messages' stamps give it. */
const localDay = (ms: number) => localStamp(new Date(ms)).slice(4, 14);
const CHECK_LINE =
  /^(?:[A-Z][a-z]{2} )?(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) ([\p{L}\p{N}][\p{L}\p{N} .,'&/+-]{0,59})$/u;

/** One after another of the same tool counts once: a reply that reads three VMs read VMs. */
export function callsKey(calls: string[]): string {
  return calls.filter((c, i) => c !== calls[i - 1]).join(" ");
}

/** A reply to the owner in the bot's chat, or a run of one of its schedules. */
export type Doer = { botId: string; scheduleId?: number };

/**
 * A reply's one call is often another question about the same guest; a schedule's run asks the same
 * thing each time, so one call that repeats is worth a script.
 */
const enough = (key: string, by: Doer) =>
  (key ? key.split(" ").length : 0) >= (by.scheduleId === undefined ? 2 : 1);

// Rows with offered = 0 are calls made, kept for the window; one with offered = 1 marks the offer,
// kept so it's made once.
const SAME = "bot_id = ?1 AND schedule_id IS ?2 AND calls = ?3";

export class Repeats {
  constructor(
    private db: Db,
    private scripts: ScriptStore,
    private clock: () => number,
  ) {}

  private since() {
    return new Date(this.clock() - WINDOW_MS).toISOString();
  }

  record(by: Doer, calls: string[]) {
    const key = callsKey(calls);
    if (!enough(key, by)) return;
    this.db
      .query("INSERT INTO reply_calls (bot_id, schedule_id, calls, at) VALUES (?, ?, ?, ?)")
      .run(by.botId, by.scheduleId ?? null, key, new Date(this.clock()).toISOString());
    this.db.query("DELETE FROM reply_calls WHERE at < ? AND offered = 0").run(this.since());
  }

  /** How many times before it made these calls, once, when it's offered nothing for them yet. */
  private seen(by: Doer, key: string, taskId?: number): number | null {
    const row = this.db
      .query<{ n: number; offered: number }, [string, number | null, string, string]>(
        `SELECT coalesce(sum(offered = 0 AND at >= ?4), 0) AS n, coalesce(max(offered), 0) AS offered
         FROM reply_calls WHERE ${SAME}`,
      )
      .get(by.botId, by.scheduleId ?? null, key, this.since());
    if (!row || row.n < SEEN || row.offered) return null;
    const scripted = this.scripts.list(by.botId).some((s) => {
      const used = [...stepsIn(s.steps)].flatMap(([x]) => ("call" in x ? [x.call] : []));
      return callsKey(used) === key;
    });
    this.db
      .query(
        "INSERT INTO reply_calls (bot_id, schedule_id, task_id, calls, at, offered) VALUES (?, ?, ?, ?, ?, 1)",
      )
      .run(
        by.botId,
        by.scheduleId ?? null,
        scripted ? null : (taskId ?? null),
        key,
        new Date(this.clock()).toISOString(),
      );
    return scripted ? null : row.n;
  }

  /** What to tell the bot, once, when this reply's calls so far are ones it has made before. */
  offer(botId: string, calls: string[]): string | null {
    const key = callsKey(calls);
    if (!enough(key, { botId })) return null;
    const n = this.seen({ botId }, key);
    if (n === null) return null;
    return `(No message from the owner: the app noticed you've made these same calls for the owner ${n + 1} times in the last 30 days: ${key.split(" ").join(", ")}. Answer as usual, then offer in a sentence to save it as a script, which runs those steps without a model whenever they ask, or on a schedule or a watcher. Save it with script_save (find it with tool_search_tool_regex "script_") only if they say yes, with what changes from one time to the next as its inputs.)`;
  }

  /** What to tell a schedule's run, once, when its calls so far are ones the schedule's runs keep making. */
  offerRun(task: Task, calls: string[]): string | null {
    if (task.scheduleId === null) return null;
    const by = { botId: task.botId, scheduleId: task.scheduleId };
    const key = callsKey(calls);
    if (!enough(key, by)) return null;
    const n = this.seen(by, key, task.id);
    if (n === null) return null;
    return `(No message from the owner: the app noticed this schedule's runs have made these same calls ${n + 1} times in the last 30 days: ${key.split(" ").join(", ")}. Carry on as usual. When you finish, end the summary with a sentence offering to save these steps as a script, which runs them without a model, and switch the schedule to run it. The owner answers in your chat, where it's done; don't save it yourself.)`;
  }

  /** A run that offered a script and then didn't finish: you never saw it, so it may be offered again. */
  withdraw(taskId: number) {
    this.db.query("DELETE FROM reply_calls WHERE task_id = ? AND offered = 1").run(taskId);
  }

  /** For the chat that hears how a run ended which offered a script: what to do if the owner says yes. */
  ranOffer(task: Task): string | null {
    const offer = this.db
      .query<{ schedule_id: number; calls: string }, [number]>(
        "SELECT schedule_id, calls FROM reply_calls WHERE task_id = ? AND offered = 1",
      )
      .get(task.id);
    if (!offer) return null;
    const tools = new Set(offer.calls.split(" "));
    const lines = this.db
      .query<{ content: string }, [number]>(
        "SELECT content FROM task_turns WHERE task_id = ? AND role = 'assistant' ORDER BY id",
      )
      .all(task.id)
      .flatMap((r) => JSON.parse(r.content) as { type: string; name?: string; input?: unknown }[])
      .filter((b) => b.type === "tool_use" && tools.has(b.name ?? ""))
      .map((b) => `${b.name} ${JSON.stringify(b.input ?? {}).slice(0, INPUT_CHARS)}`);
    let calls = lines.join("\n");
    if (calls.length > CALLS_CHARS) calls = `${calls.slice(0, CALLS_CHARS)}…`;
    return `It offered the owner to save the calls it made as a script and switch its schedule #${offer.schedule_id} "${tagText(task.source ?? task.title)}" to run it. If they say yes, save it with script_save (find it with tool_search_tool_regex "script_") from these calls, with a task step for anything that needs judgement, then automation_schedule_update with the schedule's id and the script. The calls, in order:\n${
      task.tainted
        ? untrustedBlock("calls", calls, { from: `Task #${task.id}` })
        : `<calls>\n${tagText(calls)}\n</calls>`
    }`;
  }

  /** This bot's checks, newest first, for its chat's summary to name the same check alike. */
  checkNames(botId: string): string[] {
    return this.db
      .query<{ name: string }, [string, number]>(
        "SELECT name FROM asked_checks WHERE bot_id = ? GROUP BY name ORDER BY max(id) DESC LIMIT ?",
      )
      .all(botId, KNOWN_CHECKS)
      .map((r) => r.name);
  }

  /**
   * The checks a summary of the bot's chat listed, one a line. Only those at the stamp of one of the
   * owner's messages in it (`asked`) count.
   */
  recordChecks(botId: string, episodeId: number, lines: string, asked: Set<string>) {
    const seen = new Set<string>();
    for (const line of lines.split("\n")) {
      const [, day, time, raw] = CHECK_LINE.exec(line.trim().replace(/\s+/g, " ")) ?? [];
      if (!day || !time || !raw) continue;
      const name = raw.trim().toLowerCase();
      if (!asked.has(`${day} ${time}`) || seen.has(`${day} ${time} ${name}`)) continue;
      seen.add(`${day} ${time} ${name}`);
      this.db
        .query(
          "INSERT INTO asked_checks (bot_id, name, day, time, episode_id) VALUES (?, ?, ?, ?, ?)",
        )
        .run(botId, name, day, time, episodeId);
    }
    this.db
      .query("DELETE FROM asked_checks WHERE day < ? AND offered = 0")
      .run(localDay(this.clock() - WINDOW_MS));
  }

  /** What to tell the bot, once, when the owner has asked it for the same check on several days. */
  offerSchedule(botId: string): string | null {
    const check = this.db
      .query<{ name: string; days: number }, [string, string, number]>(
        `SELECT name, count(DISTINCT day) AS days FROM asked_checks a
         WHERE bot_id = ?1 AND offered = 0 AND day >= ?2
           AND NOT EXISTS (SELECT 1 FROM asked_checks o WHERE o.bot_id = ?1 AND o.name = a.name AND o.offered = 1)
         GROUP BY name HAVING days >= ?3 ORDER BY max(id) DESC LIMIT 1`,
      )
      .get(botId, localDay(this.clock() - WINDOW_MS), CHECK_DAYS);
    if (!check) return null;
    const [day, time] = localStamp(new Date(this.clock())).slice(4).split(" ");
    this.db
      .query("INSERT INTO asked_checks (bot_id, name, day, time, offered) VALUES (?, ?, ?, ?, 1)")
      .run(botId, check.name, day ?? "", time ?? "");
    const asks = this.db
      .query<{ at: string }, [string, string, number]>(
        "SELECT day || ' ' || time AS at FROM asked_checks WHERE bot_id = ? AND name = ? AND offered = 0 ORDER BY day DESC, time DESC LIMIT ?",
      )
      .all(botId, check.name, SHOWN_ASKS)
      .map((r) => r.at)
      .reverse();
    return `(No message from the owner: the app noticed they've asked you about ${tagText(check.name)} on ${check.days} different days in the last 30 days, at ${asks.join(", ")}. Answer as usual, then offer in one sentence to look at it on a schedule, at about the time they usually ask, and tell them what you find. Make it only if they say yes, with automation_schedule_create (find it with tool_search_tool_regex "automation_"): running one of your scripts if fixed steps do it, otherwise with a prompt. If one of your schedules does this already, say nothing about it.)`;
  }
}
