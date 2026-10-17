// Approvals (PLAN.md §6.2): a task asks, you decide in the web app or from an ntfy notification.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { type Approval, type ApprovalKind, HATBOT_ID } from "@hatbot/shared";
import type { Bots } from "./bots";
import type { Db } from "./db";
import type { EventBus } from "./events";
import type { Notifier } from "./notify";

const TTL_MS = 24 * 3600_000;
/** Kinds whose notification only offers "Open in Hatbot" (PLAN.md §6.2). */
const WEB_ONLY: ApprovalKind[] = ["payment", "account_security"];

export type Outcome = "approved" | "denied" | "expired" | "cancelled";

/** Your note on an approval, for the task's tool result: it's yours, so the task follows it. */
export const ownerNote = (note: string) =>
  `The owner answered with this note. Follow it; it overrides your plan:\n<owner_note>\n${note}\n</owner_note>`;

type Row = {
  id: number;
  bot_id: string;
  task_id: number | null;
  conversation_id: number | null;
  kind: ApprovalKind;
  summary: string;
  reason: string;
  sources: string;
  screenshot_step_id: number | null;
  status: Approval["status"];
  decided_via: Approval["decidedVia"];
  created_at: string;
  expires_at: string;
  decided_at: string | null;
  cost_usd: number | null;
  note: string | null;
};

const SELECT = `SELECT a.*, (SELECT sum(cost_usd) FROM spend_ledger s WHERE s.task_id = a.task_id) AS cost_usd
  FROM approvals a`;

const toApproval = (r: Row): Approval => ({
  id: r.id,
  botId: r.bot_id,
  taskId: r.task_id,
  conversationId: r.conversation_id,
  kind: r.kind,
  summary: r.summary,
  reason: r.reason,
  sources: JSON.parse(r.sources),
  screenshotStepId: r.screenshot_step_id,
  status: r.status,
  decidedVia: r.decided_via,
  costUsd: r.cost_usd ?? 0,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  decidedAt: r.decided_at,
  note: r.note,
});

export type NewApproval = {
  taskId: number | null;
  /** The bot asking; Hatbot by default. */
  botId?: string;
  /** The chat waiting for it, when no task is. */
  conversationId?: number | null;
  kind: ApprovalKind;
  summary: string;
  reason?: string;
  sources?: string[];
  screenshotStepId?: number | null;
};

export class Approvals {
  private waiters = new Map<number, (o: Outcome) => void>();
  private key: Buffer;

  constructor(
    private db: Db,
    private events: EventBus,
    private notifier: Notifier,
    private publicUrl: string,
    private clock: () => number = Date.now,
    /** For the bot's name on notifications. */
    private bots?: Bots,
  ) {
    this.key = this.signingKey();
    // Nothing waits on approvals from before a restart: their tasks were stopped. A mandate waits for
    // no task: its negotiation takes the answer whenever it comes (PLAN.md §16.1).
    db.query(
      "UPDATE approvals SET status = 'cancelled', decided_at = ? WHERE status = 'pending' AND kind != 'mandate'",
    ).run(this.now());
  }

  private now() {
    return new Date(this.clock()).toISOString();
  }

  private signingKey(): Buffer {
    const row = this.db
      .query<{ value: string }, []>("SELECT value FROM settings WHERE key = 'approval_key'")
      .get();
    if (row) return Buffer.from(row.value, "hex");
    const key = randomBytes(32);
    this.db
      .query("INSERT INTO settings (key, value) VALUES ('approval_key', ?)")
      .run(key.toString("hex"));
    return key;
  }

  get(id: number): Approval | null {
    const r = this.db.query<Row, [number]>(`${SELECT} WHERE a.id = ?`).get(id);
    return r ? toApproval(r) : null;
  }

  /** Newest first, 100 at a time; `before`: the next page, older than that id. */
  list(pendingOnly: boolean, before?: number): Approval[] {
    const where = [
      ...(pendingOnly ? ["a.status = 'pending'"] : []),
      ...(before !== undefined ? ["a.id < ?"] : []),
    ];
    return this.db
      .query<Row, number[]>(
        `${SELECT} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY a.id DESC LIMIT 100`,
      )
      .all(...(before !== undefined ? [before] : []))
      .map(toApproval);
  }

  create(input: NewApproval): Approval {
    const row = this.db
      .query<
        { id: number },
        [
          string,
          number | null,
          number | null,
          string,
          string,
          string,
          string,
          number | null,
          string,
          string,
        ]
      >(
        `INSERT INTO approvals (bot_id, task_id, conversation_id, kind, summary, reason, sources, screenshot_step_id, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(
        input.botId ?? HATBOT_ID,
        input.taskId,
        input.conversationId ?? null,
        input.kind,
        input.summary,
        input.reason ?? "",
        JSON.stringify(input.sources ?? []),
        input.screenshotStepId ?? null,
        this.now(),
        new Date(this.clock() + TTL_MS).toISOString(),
      );
    const approval = this.get(row?.id ?? -1);
    if (!approval) throw new Error("approval insert failed");
    this.events.emit({ type: "approval.created", approval });
    void this.notify(approval);
    return approval;
  }

  /** Resolves when the approval is decided, expires or is cancelled. */
  wait(id: number, signal: AbortSignal): Promise<Outcome> {
    const current = this.get(id);
    if (current && current.status !== "pending") return Promise.resolve(current.status);
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.waiters.delete(id);
        reject(signal.reason);
      };
      if (signal.aborted) return reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      this.waiters.set(id, (o) => {
        signal.removeEventListener("abort", abort);
        resolve(o);
      });
    });
  }

  private resolve(
    id: number,
    status: Outcome,
    via: Approval["decidedVia"] = null,
    note: string | null = null,
  ): Approval | null {
    const changed = this.db
      .query(
        "UPDATE approvals SET status = ?, decided_via = ?, decided_at = ?, note = ? WHERE id = ? AND status = 'pending'",
      )
      .run(status, via, this.now(), note, id);
    if (!changed.changes) return null;
    const approval = this.get(id);
    if (approval) this.events.emit({ type: "approval.resolved", approval });
    this.waiters.get(id)?.(status);
    this.waiters.delete(id);
    return approval;
  }

  /** Your decision, with what you told the task. Null if the approval isn't pending any more. */
  decide(
    id: number,
    decision: "approve" | "deny",
    via: "web" | "ntfy",
    note?: string,
  ): Approval | null {
    return this.resolve(id, decision === "approve" ? "approved" : "denied", via, note || null);
  }

  cancel(id: number) {
    this.resolve(id, "cancelled");
  }

  cancelForTask(taskId: number) {
    const ids = this.db
      .query<{ id: number }, [number]>(
        "SELECT id FROM approvals WHERE task_id = ? AND status = 'pending'",
      )
      .all(taskId);
    for (const { id } of ids) this.resolve(id, "cancelled");
  }

  /** Expires approvals nobody answered within 24 h; the brain calls it every minute. */
  expireDue() {
    const due = this.db
      .query<{ id: number }, [string]>(
        "SELECT id FROM approvals WHERE status = 'pending' AND expires_at <= ?",
      )
      .all(this.now());
    for (const { id } of due) this.resolve(id, "expired");
  }

  sign(id: number, decision: "approve" | "deny", exp: number): string {
    return createHmac("sha256", this.key).update(`${id}:${decision}:${exp}`).digest("base64url");
  }

  /** An ntfy button's token: right signature, not expired. Single use, because a decision only applies once. */
  verify(id: number, decision: "approve" | "deny", exp: number, sig: string): boolean {
    if (exp * 1000 < this.clock()) return false;
    const want = Buffer.from(this.sign(id, decision, exp));
    const got = Buffer.from(sig);
    return got.length === want.length && timingSafeEqual(got, want);
  }

  private async notify(a: Approval) {
    const open = `${this.publicUrl}/?approval=${a.id}`;
    const exp = Math.floor(Date.parse(a.expiresAt) / 1000);
    const button = (decision: "approve" | "deny") => ({
      action: "http" as const,
      label: decision === "approve" ? "Approve" : "Deny",
      url: `${this.publicUrl}/api/v1/approvals/${a.id}/token-decision`,
      method: "POST" as const,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision, exp, sig: this.sign(a.id, decision, exp) }),
      clear: true,
    });
    // A long summary (a whole command) is cut in the title, so the message has it in full.
    const who = a.botId === HATBOT_ID ? "" : `${this.bots?.nameOf(a.botId) ?? a.botId} · `;
    const title = `${who}Approve: ${a.summary}`;
    const cut = title.length > 120;
    await this.notifier.send({
      title: cut ? `${title.slice(0, 119)}…` : title,
      message: [
        cut ? a.summary : "",
        a.reason,
        a.taskId ? `Task #${a.taskId}, $${a.costUsd.toFixed(2)} so far` : "",
      ]
        .filter(Boolean)
        .join("\n"),
      priority: 4,
      click: open,
      actions: WEB_ONLY.includes(a.kind)
        ? [{ action: "view", label: "Open in Hatbot", url: open }]
        : [button("approve"), button("deny")],
    });
  }
}
