// The weekly report: the last seven days in a few lines, made without the model, in Hatbot's chat and
// as a notification.
import type { Chats } from "./agent/chats";
import type { Bots } from "./bots";
import type { Db } from "./db";
import type { MemoryStore } from "./memory/store";
import type { Notifier } from "./notify";
import type { SettingsStore } from "./settings";

const LAST_KEY = "report:last";
const WEEK = 7 * 86400_000;

export type ReportDeps = {
  db: Db;
  settings: SettingsStore;
  chats: Chats;
  notifier: Notifier;
  bots: Bots;
  memory: MemoryStore;
  publicUrl: string;
  clock?: () => number;
};

const usd = (n: number) => `$${n.toFixed(2)}`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export class WeeklyReport {
  private clock: () => number;
  private sending = false;

  constructor(private d: ReportDeps) {
    this.clock = d.clock ?? Date.now;
  }

  /** The last time it was due at or before `now`, in the brain's time zone. */
  private dueAt(now: number): number {
    const { weekday, hour } = this.d.settings.get().weeklyReport;
    const t = new Date(now);
    t.setHours(hour, 0, 0, 0);
    t.setDate(t.getDate() - ((t.getDay() - weekday + 7) % 7));
    if (t.getTime() > now) t.setDate(t.getDate() - 7);
    return t.getTime();
  }

  /** Sends it once it's due; the brain calls it every few seconds. A day late at most. */
  tick() {
    const s = this.d.settings.get();
    if (s.paused || !s.weeklyReport.enabled || this.sending) return;
    const now = this.clock();
    const due = this.dueAt(now);
    const last = this.lastSent();
    if ((last !== null && last >= due) || now - due > 86400_000) return;
    void this.send();
  }

  async send(): Promise<string> {
    this.sending = true;
    try {
      const { text, line } = await this.make();
      this.d.db
        .query(
          "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        )
        .run(LAST_KEY, new Date(this.clock()).toISOString());
      this.d.chats.note("hatbot", text);
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
    const v = this.d.db
      .query<{ value: string }, [string]>("SELECT value FROM settings WHERE key = ?")
      .get(LAST_KEY)?.value;
    return v ? Date.parse(v) : null;
  }

  /** The report in Markdown, and a line for the notification. */
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
    if (answered || expired)
      lines.push(
        `- ${plural(answered, "approval")} answered${expired ? `, ${expired} expired unanswered` : ""}.`,
      );
    if (counted) lines.push(`- Watchers saw ${plural(counted, "change")} that counted.`);
    if (failing.length) lines.push(`- Watchers that can't read their page: ${failing.join(", ")}.`);
    if (commits) lines.push(`- Memory: ${plural(commits, "change")}.`);
    const line = [
      `${usd(total)} spent`,
      `${plural(ran, "task")}${count("failed") ? ` (${count("failed")} failed)` : ""}`,
      ...(expired ? [`${plural(expired, "approval")} expired`] : []),
    ].join(", ");
    return { text: lines.join("\n"), line: `${line}.` };
  }
}
