// The weekly report: the last seven days in a few lines, made without the model, in Hatbot's chat and
// as a notification.
import { HATBOT_ID, lastDue, localDay, parseTodos, TODO_FILE } from "@hatbot/shared";
import type { Deps } from "./deps";

const LAST_KEY = "report";
const WEEK = 7 * 86400_000;

export type ReportDeps = Pick<
  Deps,
  "db" | "settings" | "chats" | "notifier" | "bots" | "memory" | "storage" | "model" | "store"
> & { publicUrl: string; clock?: () => number };

const usd = (n: number) => `$${n.toFixed(2)}`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export class WeeklyReport {
  private clock: () => number;
  private sending = false;
  private failedAt = Number.NEGATIVE_INFINITY;

  constructor(private d: ReportDeps) {
    this.clock = d.clock ?? Date.now;
  }

  /** A day late at most. */
  tick() {
    const s = this.d.settings.get();
    if (s.paused || !s.weeklyReport.enabled || this.sending) return;
    const now = this.clock();
    const { weekday, hour } = s.weeklyReport;
    const due = lastDue(now, weekday, hour);
    const last = this.lastSent();
    if ((last !== null && last >= due) || now - due > 86400_000) return;
    // One that failed is tried again an hour later, not on every tick.
    if (now - this.failedAt < 3600_000) return;
    void this.send().catch((err) => {
      this.failedAt = this.clock();
      console.error("weekly report failed", err);
    });
  }

  async send(): Promise<string> {
    this.sending = true;
    try {
      const { text, line } = await this.make();
      this.d.store.set(LAST_KEY, new Date(this.clock()).toISOString());
      this.d.chats.note(HATBOT_ID, text);
      void this.d.notifier.send({
        title: "Your week",
        message: line,
        priority: 2,
        click: this.d.publicUrl,
      });
      return text;
    } finally {
      this.sending = false;
    }
  }

  private lastSent(): number | null {
    const v = this.d.store.get(LAST_KEY);
    return v ? Date.parse(v) : null;
  }

  async make(): Promise<{ text: string; line: string }> {
    const db = this.d.db;
    const since = new Date(this.clock() - WEEK).toISOString();
    const spend = db
      .query<{ bot: string; usd: number }, [string]>(
        `SELECT coalesce(bot_id, 'hatbot') AS bot, sum(cost_usd) AS usd FROM spend_ledger
         WHERE created_at >= ? GROUP BY bot ORDER BY usd DESC`,
      )
      .all(since);
    const total = spend.reduce((n, r) => n + r.usd, 0);
    const tasks = db
      .query<{ status: string; n: number }, [string]>(
        `SELECT status, count(*) AS n FROM tasks WHERE parent_id IS NULL AND created_at >= ? GROUP BY status`,
      )
      .all(since);
    const count = (status: string) => tasks.find((t) => t.status === status)?.n ?? 0;
    const ran = tasks.reduce((n, t) => n + t.n, 0);
    const failed = db
      .query<{ id: number; title: string }, [string]>(
        `SELECT id, title FROM tasks WHERE parent_id IS NULL AND status = 'failed' AND created_at >= ?
         ORDER BY id DESC LIMIT 5`,
      )
      .all(since);
    // By the model each started on, desktop tasks that background tasks started included.
    const desktop = db
      .query<{ model: string; done: number; failed: number; rescued: number }, [string]>(
        `SELECT coalesce(escalated_from, model) AS model,
         sum(status = 'done' AND escalated_from IS NULL) AS done,
         sum(status = 'failed' OR escalated_from IS NOT NULL) AS failed,
         sum(status = 'done' AND escalated_from IS NOT NULL) AS rescued
         FROM tasks WHERE lane = 'screen' AND created_at >= ? GROUP BY 1 ORDER BY 1`,
      )
      .all(since)
      .filter((r) => r.done || r.failed);
    const approvals = db
      .query<{ status: string; n: number }, [string]>(
        "SELECT status, count(*) AS n FROM approvals WHERE created_at >= ? GROUP BY status",
      )
      .all(since);
    const answered = approvals
      .filter((a) => a.status === "approved" || a.status === "denied")
      .reduce((n, a) => n + a.n, 0);
    const expired = approvals.find((a) => a.status === "expired")?.n ?? 0;
    const counted =
      db
        .query<{ n: number }, [string]>(
          "SELECT count(*) AS n FROM watcher_values WHERE fired = 1 AND created_at >= ?",
        )
        .get(since)?.n ?? 0;
    const failing = db
      .query<{ name: string }, []>("SELECT name FROM watchers WHERE enabled = 1 AND errors > 0")
      .all()
      .map((w) => `"${w.name}"`);
    const commits = (await this.d.memory.log(200)).filter(
      (c) => Date.parse(c.date) >= Date.parse(since),
    ).length;

    const lines = ["**Your week**", ""];
    lines.push(
      `- Spent ${usd(total)}${spend.length > 1 ? `: ${spend.map((r) => `${this.d.bots.nameOf(r.bot)} ${usd(r.usd)}`).join(", ")}` : ""}.`,
    );
    lines.push(
      ran
        ? `- ${plural(ran, "task")}: ${count("done")} done, ${count("failed")} failed${count("cancelled") ? `, ${count("cancelled")} cancelled` : ""}.`
        : "- No tasks.",
    );
    for (const t of failed) lines.push(`  - Failed: [${t.title}](/tasks/${t.id})`);
    for (const r of desktop)
      lines.push(
        `- Desktop on ${this.d.model.name(r.model)}: ${r.done} done, ${r.failed} failed${r.rescued ? `, ${r.rescued} of them then done on another model` : ""}.`,
      );
    if (answered || expired)
      lines.push(
        `- ${plural(answered, "approval")} answered${expired ? `, ${expired} expired unanswered` : ""}.`,
      );
    if (counted) lines.push(`- Watchers saw ${plural(counted, "change")} that counted.`);
    if (failing.length) lines.push(`- Watchers that can't read their page: ${failing.join(", ")}.`);
    if (commits) lines.push(`- Memory: ${plural(commits, "change")}.`);
    // Ticked off on one of the last seven days, and open past their date.
    const todos = parseTodos((await this.d.memory.readOrNull(TODO_FILE)) ?? "");
    const weekAgo = localDay(new Date(this.clock() - WEEK));
    const today = localDay(new Date(this.clock()));
    const ticked = todos.filter((t) => t.done && (t.doneOn ?? "") > weekAgo).length;
    const overdue = todos.filter((t) => !t.done && t.due && t.due < today).length;
    if (ticked || overdue) lines.push(`- To-do: ${ticked} done, ${overdue} overdue.`);
    const storage = await this.d.storage.line().catch(() => null);
    if (storage) lines.push(`- Storage: ${storage}`);
    const line = [
      `${usd(total)} spent`,
      `${plural(ran, "task")}${count("failed") ? ` (${count("failed")} failed)` : ""}`,
      ...(expired ? [`${plural(expired, "approval")} expired`] : []),
    ].join(", ");
    return { text: lines.join("\n"), line: `${line}.` };
  }
}
