import { createHmac } from "node:crypto";
import type { Notifier } from "@hatbot/plugin-sdk";
import {
  type Approval,
  type ApprovalKind,
  type ApprovalRule,
  type ApprovalScope,
  HATBOT_ID,
} from "@hatbot/shared";
import { sameText, secretKey } from "./auth/keys";
import type { Bots } from "./bots";
import type { Db } from "./db";
import type { EventBus } from "./events";

const TTL_MS = 24 * 3600_000;
/** Kinds a notification may approve from a locked phone; the rest are approved in the app. */
const NOTIFY_APPROVES: ApprovalKind[] = [
  "send",
  "submit_personal_data",
  "delete",
  "listing",
  "other",
];
export const approvableFromNotification = (kind: ApprovalKind) => NOTIFY_APPROVES.includes(kind);

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
  scopes: string;
  scope: ApprovalScope | null;
  episode_id: number | null;
  answers: string;
};

const SELECT = `SELECT a.*, (SELECT sum(cost_usd) FROM spend_ledger s WHERE s.task_id = a.task_id) AS cost_usd
  FROM approvals a`;

const toApproval = (r: Row): Approval => ({
  id: r.id,
  botId: r.bot_id,
  taskId: r.task_id,
  conversationId: r.conversation_id,
  episodeId: r.episode_id,
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
  scopes: JSON.parse(r.scopes),
  scope: r.scope,
  answers: JSON.parse(r.answers),
});

/** A call's input as one string, keys sorted, so the same call always reads the same. */
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_k, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
}

export type NewApproval = {
  taskId: number | null;
  botId?: string;
  /** The chat waiting for it, when no task is. */
  conversationId?: number | null;
  kind: ApprovalKind;
  summary: string;
  reason?: string;
  sources?: string[];
  screenshotStepId?: number | null;
  /** The plugin call it's for, which a scope beyond once applies to. */
  call?: { tool: string; input: unknown; target: string | null };
  /** The chat conversation asking, for a scope over the rest of it. */
  episodeId?: number | null;
  scopes?: ApprovalScope[];
  answers?: string[];
};

export type Granted = {
  botId: string;
  tool: string;
  input: unknown;
  target: string | null;
  taskId?: number;
  episodeId?: number;
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
    private bots?: Bots,
  ) {
    this.key = secretKey(db, "approval_key");
    // Nothing waits on approvals from before a restart: their tasks were stopped. A negotiation's
    // mandate or hold, or a listing, waits for no task: it takes the answer whenever it comes.
    db.query(
      `UPDATE approvals SET status = 'cancelled', decided_at = ? WHERE status = 'pending' AND kind NOT IN ('mandate', 'listing')
       AND id NOT IN (SELECT approval_id FROM negotiations WHERE approval_id IS NOT NULL)`,
    ).run(this.now());
  }

  private now() {
    return new Date(this.clock()).toISOString();
  }

  get(id: number): Approval | null {
    const r = this.db.query<Row, [number]>(`${SELECT} WHERE a.id = ?`).get(id);
    return r ? toApproval(r) : null;
  }

  /** Newest first, 100 at a time; `before`: the next page, older than that id. `pendingOnly` keeps what's blocked too. */
  list(pendingOnly: boolean, before?: number): Approval[] {
    const where = [
      ...(pendingOnly ? ["a.status IN ('pending', 'blocked')"] : []),
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
          string,
        ]
      >(
        `INSERT INTO approvals (bot_id, task_id, conversation_id, kind, summary, reason, sources, screenshot_step_id, created_at, expires_at, answers)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
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
        JSON.stringify(input.answers ?? []),
      );
    if (row && input.call)
      this.db
        .query(
          "UPDATE approvals SET tool = ?, input = ?, target = ?, episode_id = ?, scopes = ? WHERE id = ?",
        )
        .run(
          input.call.tool,
          canonical(input.call.input),
          input.call.target ?? "",
          input.episodeId ?? null,
          JSON.stringify(input.scopes ?? []),
          row.id,
        );
    const approval = this.get(row?.id ?? -1);
    if (!approval) throw new Error("approval insert failed");
    this.events.emit({ type: "approval.created", approval });
    void this.notify(approval);
    return approval;
  }

  wait(id: number, signal: AbortSignal): Promise<Outcome> {
    const current = this.get(id);
    if (current && current.status !== "pending")
      return Promise.resolve(current.status === "blocked" ? "denied" : current.status);
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

  /** Null if the approval isn't pending any more, or it's one a notification can't approve. */
  decide(
    id: number,
    decision: "approve" | "deny",
    via: "web" | "ntfy",
    note?: string,
    scope?: ApprovalScope,
  ): Approval | null {
    const a = this.get(id);
    if (via === "ntfy" && decision === "approve" && (!a || !approvableFromNotification(a.kind)))
      return null;
    if (scope && decision === "approve" && a?.status === "pending" && a.scopes.includes(scope)) {
      this.db.query("UPDATE approvals SET scope = ? WHERE id = ?").run(scope, id);
      if (scope === "always")
        this.db
          .query(
            `INSERT INTO approval_rules (bot_id, tool, input, summary, created_at)
             SELECT bot_id, tool, input, summary, ? FROM approvals WHERE id = ?
             ON CONFLICT (bot_id, tool, input) DO NOTHING`,
          )
          .run(this.now(), id);
    }
    return this.resolve(id, decision === "approve" ? "approved" : "denied", via, note || null);
  }

  /**
   * Why a call that would ask or be reviewed goes ahead on what you said before, or null: this exact
   * call is one you always allow, or one the review blocked that you ran anyway, which goes once.
   */
  granted(q: Granted): string | null {
    const input = canonical(q.input);
    const rule = this.db
      .query<{ id: number }, [string, string, string]>(
        "SELECT id FROM approval_rules WHERE bot_id = ? AND tool = ? AND input = ?",
      )
      .get(q.botId, q.tool, input);
    if (rule) return "You always allow this.";
    const anyway = this.db
      .query<{ id: number }, [string, string, string, string]>(
        `UPDATE approvals SET used_at = ?1 WHERE id = (SELECT id FROM approvals WHERE blocked = 1
         AND status = 'approved' AND used_at IS NULL AND bot_id = ?2 AND tool = ?3 AND input = ?4
         ORDER BY id LIMIT 1) RETURNING id`,
      )
      .get(this.now(), q.botId, q.tool, input);
    return anyway ? "You chose to run it anyway." : null;
  }

  /** What the safety review blocked: nothing waits on it, and you may run it anyway for a day. */
  block(input: NewApproval): Approval {
    const row = this.db
      .query<
        { id: number },
        [string, number | null, number | null, string, string, string, string, string, string]
      >(
        `INSERT INTO approvals (bot_id, task_id, conversation_id, kind, summary, reason, sources, status, blocked, created_at, decided_at, expires_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'blocked', 1, ?8, ?8, ?9) RETURNING id`,
      )
      .get(
        input.botId ?? HATBOT_ID,
        input.taskId,
        input.conversationId ?? null,
        input.kind,
        input.summary,
        input.reason ?? "",
        JSON.stringify(input.sources ?? []),
        this.now(),
        new Date(this.clock() + TTL_MS).toISOString(),
      );
    if (row && input.call)
      this.db
        .query(
          "UPDATE approvals SET tool = ?, input = ?, target = ?, episode_id = ?, scopes = ? WHERE id = ?",
        )
        .run(
          input.call.tool,
          canonical(input.call.input),
          input.call.target ?? "",
          input.episodeId ?? null,
          JSON.stringify(input.scopes ?? []),
          row.id,
        );
    const approval = this.get(row?.id ?? -1);
    if (!approval) throw new Error("approval insert failed");
    this.events.emit({ type: "approval.created", approval });
    return approval;
  }

  /** Lets what the review blocked run once, or always as a rule; null if it's no longer blocked. */
  runAnyway(id: number, always: boolean): Approval | null {
    const a = this.get(id);
    if (a?.status !== "blocked") return null;
    const scope = always && a.scopes.includes("always") ? "always" : null;
    if (scope)
      this.db
        .query(
          `INSERT INTO approval_rules (bot_id, tool, input, summary, created_at)
           SELECT bot_id, tool, input, summary, ? FROM approvals WHERE id = ? AND tool IS NOT NULL
           ON CONFLICT (bot_id, tool, input) DO NOTHING`,
        )
        .run(this.now(), id);
    const changed = this.db
      .query(
        "UPDATE approvals SET status = 'approved', decided_via = 'web', decided_at = ?, scope = ? WHERE id = ? AND status = 'blocked'",
      )
      .run(this.now(), scope, id);
    if (!changed.changes) return null;
    const approval = this.get(id);
    if (approval) this.events.emit({ type: "approval.resolved", approval });
    return approval;
  }

  rules(): ApprovalRule[] {
    return this.db
      .query<{ id: number; bot_id: string; tool: string; summary: string; created_at: string }, []>(
        "SELECT id, bot_id, tool, summary, created_at FROM approval_rules ORDER BY id DESC",
      )
      .all()
      .map((r) => ({
        id: r.id,
        botId: r.bot_id,
        tool: r.tool,
        summary: r.summary,
        createdAt: r.created_at,
      }));
  }

  removeRule(id: number): boolean {
    return this.db.query("DELETE FROM approval_rules WHERE id = ?").run(id).changes > 0;
  }

  /** Leaves what the review blocked as it is; false if it isn't blocked any more. */
  dismiss(id: number): boolean {
    const a = this.db
      .query<{ id: number }, [string, number]>(
        "UPDATE approvals SET status = 'cancelled', decided_at = ? WHERE id = ? AND status = 'blocked' RETURNING id",
      )
      .get(this.now(), id);
    const approval = a && this.get(a.id);
    if (approval) this.events.emit({ type: "approval.resolved", approval });
    return Boolean(approval);
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

  expireDue() {
    const due = this.db
      .query<{ id: number }, [string]>(
        "SELECT id FROM approvals WHERE status = 'pending' AND expires_at <= ?",
      )
      .all(this.now());
    for (const { id } of due) this.resolve(id, "expired");
    const blocked = this.db
      .query<{ id: number }, [string]>(
        "UPDATE approvals SET status = 'expired' WHERE status = 'blocked' AND expires_at <= ? RETURNING id",
      )
      .all(this.now());
    for (const { id } of blocked) {
      const approval = this.get(id);
      if (approval) this.events.emit({ type: "approval.resolved", approval });
    }
  }

  sign(id: number, decision: "approve" | "deny", exp: number): string {
    return this.mac(`${id}:${decision}:${exp}`);
  }

  /** An ntfy button's token: right signature, not expired. Single use, because a decision only applies once. */
  verify(id: number, decision: "approve" | "deny", exp: number, sig: string): boolean {
    return this.checkSig(`${id}:${decision}:${exp}`, exp, sig);
  }

  /** The Pause all button's token, signed apart from any decision so it can't stand for one. */
  signPause(exp: number): string {
    return this.mac(`pause-all:${exp}`);
  }

  verifyPause(exp: number, sig: string): boolean {
    return this.checkSig(`pause-all:${exp}`, exp, sig);
  }

  private mac(payload: string): string {
    return createHmac("sha256", this.key).update(payload).digest("base64url");
  }

  private checkSig(payload: string, exp: number, sig: string): boolean {
    return exp * 1000 >= this.clock() && sameText(sig, this.mac(payload));
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
    // Stopping everything is always safe, so it's offered on every approval, even where deciding isn't.
    const pause = {
      action: "http" as const,
      label: "Pause all",
      url: `${this.publicUrl}/api/v1/pause-all/token`,
      method: "POST" as const,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ exp, sig: this.signPause(exp) }),
    };
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
      actions: approvableFromNotification(a.kind)
        ? [button("approve"), button("deny"), pause]
        : [{ action: "view", label: "Open in Hatbot", url: open }, button("deny"), pause],
    });
  }
}
