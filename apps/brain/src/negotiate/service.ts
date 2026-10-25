// Scout's tools are called by name through the MCP plugin, as watchers call plugin tools.
import {
  type Appraisal,
  type Approval,
  type Bot,
  type Claims,
  type Mandate,
  type Negotiation,
  type NegotiationDetail,
  type NegotiationMessage,
  type NegotiationStatus,
  OPEN_NEGOTIATION_STATUSES,
  type Stated,
  type Task,
} from "@hatbot/shared";
import type { ModelClient } from "../agent/model";
import type { Approvals } from "../approvals";
import { type Bots, botFolder } from "../bots";
import type { Db } from "../db";
import type { Desktop } from "../desktop/service";
import type { EventBus } from "../events";
import type { MemoryStore } from "../memory/store";
import { type CallContext, PluginError, type PluginTool } from "../plugins/plugin";
import { runPluginTool, verdictFor } from "../plugins/registry";
import type { Spend } from "../spend";
import type { Tasks } from "../tasks/service";
import { type ListingFacts, parseKey, scoutTool } from "./appraise";
import { collapse, namesListing, type SendGate, sameAddress, sameHost } from "./gate";
import {
  applyNote,
  mandateAims,
  mandateReason,
  mandateSummary,
  quotedTitle,
  widened,
} from "./mandate";
import { QUIET_HOURS, type SendFacts, type SendInput } from "./policy";
import { scamSignals } from "./scam";
import { negotiateTools } from "./tools";

export type NegotiationsDeps = {
  db: Db;
  events: EventBus;
  tasks: Tasks;
  approvals: Approvals;
  bots: Bots;
  memory: MemoryStore;
  desktop: Desktop;
  model: ModelClient;
  spend: Spend;
  clock?: () => number;
};

type Row = {
  id: number;
  want_id: number;
  want: string;
  bot_id: string;
  conversation_id: number | null;
  role: "buy" | "sell";
  listing_key: string;
  listing_url: string;
  title: string;
  asking: number | null;
  mandate: string;
  appraisal: string | null;
  conversation_url: string | null;
  claims: string;
  status: NegotiationStatus;
  agreed_price: number | null;
  approval_id: number | null;
  next_follow_up_at: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
};

type MessageRow = {
  id: number;
  negotiation_id: number;
  direction: "in" | "out";
  text: string;
  offer: number | null;
  agree: number;
  stated: string | null;
  status: NegotiationMessage["status"];
  task_id: number | null;
  created_at: string;
  sent_at: string | null;
};

const SELECT = `SELECT n.*, w.text AS want FROM negotiations n JOIN wants w ON w.id = n.want_id`;
const OPEN = OPEN_NEGOTIATION_STATUSES.map((s) => `'${s}'`).join(", ");
const MESSAGE_SELECT = `SELECT m.*, (SELECT task_id FROM negotiation_tasks t WHERE t.message_id = m.id) AS task_id
  FROM negotiation_messages m`;

export const NO_CLAIMS: Claims = { max: null, otherOffers: null, timing: null, other: [] };

const toMessage = (r: MessageRow): NegotiationMessage => ({
  id: r.id,
  negotiationId: r.negotiation_id,
  direction: r.direction,
  text: r.text,
  offer: r.offer,
  agree: Boolean(r.agree),
  stated: r.stated ? (JSON.parse(r.stated) as Stated) : null,
  status: r.status,
  taskId: r.task_id,
  createdAt: r.created_at,
  sentAt: r.sent_at,
});

// The column also keeps the owner's note the mandate was made from, which isn't part of the mandate.
const mandateOf = (json: string): Mandate => {
  const { note: _, ...mandate } = JSON.parse(json) as Mandate & { note?: string };
  return mandate;
};

const keyOf = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

export type ConversationReport = { from: "seller" | "us"; text: string }[];

export type Recorded = { text: string; stale: boolean; alreadySent: boolean };

const FINAL_TASK = ["done", "failed", "cancelled"];
export const MAX_TEXT = 1000;

export class Negotiations {
  readonly clock: () => number;
  private applying = new Set<number>();

  constructor(readonly d: NegotiationsDeps) {
    this.clock = d.clock ?? Date.now;
    // A send whose task ended while the brain was down never went, as far as anyone can tell.
    d.db
      .query(
        `UPDATE negotiation_messages SET status = 'failed' WHERE status = 'sending' AND id IN (
           SELECT nt.message_id FROM negotiation_tasks nt JOIN tasks t ON t.id = nt.task_id
           WHERE t.status IN ('done', 'failed', 'cancelled'))`,
      )
      .run();
    d.events.on((e) => {
      if (e.type === "task.updated" && FINAL_TASK.includes(e.task.status)) this.taskEnded(e.task);
      if (e.type === "approval.resolved") this.decided(e.approval);
    });
  }

  /** Told by the event, or found by due(). */
  private decided(a: Approval) {
    const run =
      a.kind === "mandate"
        ? this.mandateDecided(a)
        : a.kind === "injection_warning"
          ? this.holdDecided(a)
          : null;
    void run?.catch((err) => console.error(`approval ${a.id} failed`, err));
  }

  now() {
    return new Date(this.clock()).toISOString();
  }

  get(id: number): Negotiation | null {
    return (
      this.negotiations(this.d.db.query<Row, [number]>(`${SELECT} WHERE n.id = ?`).all(id))[0] ??
      null
    );
  }

  list(opts: { botId?: string; open?: boolean } = {}): Negotiation[] {
    const where: string[] = [];
    const args: string[] = [];
    if (opts.botId) {
      where.push("n.bot_id = ?");
      args.push(opts.botId);
    }
    if (opts.open !== undefined) where.push(`n.status ${opts.open ? "" : "NOT "}IN (${OPEN})`);
    const rows = this.d.db
      .query<Row, string[]>(
        `${SELECT}${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY n.id DESC LIMIT 200`,
      )
      .all(...args);
    return this.negotiations(rows);
  }

  messages(id: number): NegotiationMessage[] {
    return this.d.db
      .query<MessageRow, [number]>(`${MESSAGE_SELECT} WHERE m.negotiation_id = ? ORDER BY m.id`)
      .all(id)
      .map(toMessage);
  }

  detail(id: number): NegotiationDetail | null {
    const negotiation = this.get(id);
    return negotiation ? { negotiation, messages: this.messages(id) } : null;
  }

  private message(id: number): NegotiationMessage | null {
    const r = this.d.db.query<MessageRow, [number]>(`${MESSAGE_SELECT} WHERE m.id = ?`).get(id);
    return r ? toMessage(r) : null;
  }

  private negotiations(rows: Row[]): Negotiation[] {
    const last = new Map(
      this.d.db
        .query<MessageRow, [string]>(
          `${MESSAGE_SELECT} WHERE m.id IN (SELECT max(id) FROM negotiation_messages WHERE status != 'failed'
           AND negotiation_id IN (SELECT value FROM json_each(?)) GROUP BY negotiation_id)`,
        )
        .all(JSON.stringify(rows.map((r) => r.id)))
        .map((m) => [m.negotiation_id, toMessage(m)]),
    );
    return rows.map((r) => ({
      id: r.id,
      botId: r.bot_id,
      wantId: r.want_id,
      want: r.want,
      role: r.role,
      listingKey: r.listing_key,
      listingUrl: r.listing_url,
      title: r.title,
      asking: r.asking,
      mandate: mandateOf(r.mandate),
      appraisal: r.appraisal ? (JSON.parse(r.appraisal) as Appraisal) : null,
      conversationUrl: r.conversation_url,
      claims: { ...NO_CLAIMS, ...(JSON.parse(r.claims) as Partial<Claims>) },
      status: r.status,
      agreedPrice: r.agreed_price,
      approvalId: r.approval_id,
      conversationId: r.conversation_id,
      nextFollowUpAt: r.next_follow_up_at,
      lastMessage: last.get(r.id) ?? null,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      closedAt: r.closed_at,
    }));
  }

  update(id: number, set: Record<string, string | number | null>) {
    const cols = { ...set, updated_at: this.now() };
    this.d.db
      .query(
        `UPDATE negotiations SET ${Object.keys(cols)
          .map((k) => `${k} = ?`)
          .join(", ")} WHERE id = ?`,
      )
      .run(...Object.values(cols), id);
    this.emit(id);
  }

  emit(id: number) {
    const negotiation = this.get(id);
    if (negotiation) this.d.events.emit({ type: "negotiation.updated", negotiation });
  }

  /** None without Scout, whose scout_listing_detail every negotiation starts from. */
  tools(bot: Bot, available: PluginTool[], where: { conversationId: number | null }): PluginTool[] {
    if (!scoutTool(available, "scout_listing_detail")) return [];
    return negotiateTools(this, bot, available, where);
  }

  mine(bot: Bot, id: number): Negotiation {
    const n = this.get(id);
    if (!n || n.botId !== bot.id) throw new PluginError(`There's no negotiation #${id}.`);
    return n;
  }

  wantFor(bot: Bot, want: number | string | undefined, title: string): number {
    if (typeof want === "number") {
      const w = this.d.db
        .query<{ id: number; status: string }, [number, string]>(
          "SELECT id, status FROM wants WHERE id = ? AND bot_id = ?",
        )
        .get(want, bot.id);
      if (!w) throw new PluginError(`There's no want #${want}.`);
      if (w.status !== "open") throw new PluginError(`Want #${want} is ${w.status}.`);
      return w.id;
    }
    const id = this.d.db
      .query<{ id: number }, [string, string, string]>(
        "INSERT INTO wants (bot_id, text, created_at) VALUES (?, ?, ?) RETURNING id",
      )
      .get(bot.id, (want ?? title).slice(0, 200), this.now())?.id;
    if (!id) throw new Error("want insert failed");
    return id;
  }

  create(input: {
    bot: Bot;
    wantId: number;
    listing: ListingFacts;
    mandate: Mandate;
    appraisal: Appraisal | null;
    status: NegotiationStatus;
    conversationId: number | null;
    messageId?: number;
  }): Negotiation {
    const now = this.now();
    const id = this.d.db
      .query<{ id: number }, (string | number | null)[]>(
        `INSERT INTO negotiations (want_id, bot_id, conversation_id, role, listing_key, listing_url, title,
           asking, mandate, appraisal, status, created_at, updated_at)
         VALUES (?, ?, ?, 'buy', ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(
        input.wantId,
        input.bot.id,
        input.conversationId,
        input.listing.key,
        input.listing.url,
        input.listing.title.slice(0, 300),
        input.listing.asking,
        JSON.stringify(input.mandate),
        input.appraisal ? JSON.stringify(input.appraisal) : null,
        input.status,
        now,
        now,
      )?.id;
    if (!id) throw new Error("negotiation insert failed");
    if (input.messageId) this.attach(input.messageId, id);
    this.emit(id);
    return this.get(id) as Negotiation;
  }

  private attach(messageId: number, negotiationId: number) {
    const done = this.d.db
      .query(
        "UPDATE messages SET negotiation_id = ? WHERE id = ? AND negotiation_id IS NULL AND kind IN ('text', 'command')",
      )
      .run(negotiationId, messageId).changes;
    if (done) this.d.events.emit({ type: "message.negotiation", id: messageId, negotiationId });
  }

  busy(listingKey: string, wantId: number): Negotiation | null {
    const rows = this.d.db
      .query<Row, [string, number]>(
        `${SELECT} WHERE n.status IN (${OPEN}) AND (n.listing_key = ? OR n.want_id = ?) LIMIT 1`,
      )
      .all(listingKey, wantId);
    return this.negotiations(rows)[0] ?? null;
  }

  inFlight(id: number): { messageId: number; taskId: number | null } | null {
    const r = this.d.db
      .query<{ id: number; task_id: number | null }, [number]>(
        `SELECT m.id, (SELECT task_id FROM negotiation_tasks t WHERE t.message_id = m.id) AS task_id
         FROM negotiation_messages m WHERE m.negotiation_id = ? AND m.status = 'sending' LIMIT 1`,
      )
      .get(id);
    return r ? { messageId: r.id, taskId: r.task_id } : null;
  }

  checking(id: number): number | null {
    const r = this.d.db
      .query<{ task_id: number }, [number]>(
        `SELECT nt.task_id FROM negotiation_tasks nt JOIN tasks t ON t.id = nt.task_id
         WHERE nt.negotiation_id = ? AND nt.message_id IS NULL
           AND t.status IN ('queued', 'running', 'waiting_approval', 'waiting_takeover', 'waiting_answer') LIMIT 1`,
      )
      .get(id);
    return r?.task_id ?? null;
  }

  facts(n: Negotiation): SendFacts {
    const now = this.clock();
    const sent = "m.direction = 'out' AND m.status IN ('sending', 'sent', 'unconfirmed')";
    const starts = !this.d.db
      .query<{ id: number }, [number]>(
        `SELECT m.id FROM negotiation_messages m WHERE m.negotiation_id = ? AND ${sent} LIMIT 1`,
      )
      .get(n.id);
    // The account is the bot's login on the marketplace: conversations it started there in 24 hours.
    const startedToday =
      this.d.db
        .query<{ c: number }, [string, string, string]>(
          `SELECT COUNT(*) AS c FROM (
             SELECT MIN(m.created_at) AS first FROM negotiation_messages m
             JOIN negotiations n ON n.id = m.negotiation_id
             WHERE ${sent} AND n.bot_id = ?
               AND substr(n.listing_key, 1, instr(n.listing_key, ':') - 1) = ?
             GROUP BY m.negotiation_id
           ) WHERE first >= ?`,
        )
        .get(
          n.botId,
          parseKey(n.listingKey)?.marketplace ?? "",
          new Date(now - 86_400_000).toISOString(),
        )?.c ?? 0;
    const last = this.d.db
      .query<{ id: number; at: string }, [number]>(
        `SELECT m.id, coalesce(m.sent_at, m.created_at) AS at FROM negotiation_messages m
         WHERE m.negotiation_id = ? AND m.direction = 'out' AND m.status IN ('sent', 'unconfirmed')
         ORDER BY m.id DESC LIMIT 1`,
      )
      .get(n.id);
    const answered =
      last &&
      this.d.db
        .query<{ id: number }, [number, number]>(
          "SELECT id FROM negotiation_messages WHERE negotiation_id = ? AND direction = 'in' AND id > ? LIMIT 1",
        )
        .get(n.id, last.id);
    const seller = this.d.db
      .query<{ text: string; after: number }, [number, number]>(
        `SELECT text, id > ? AS after FROM negotiation_messages
         WHERE negotiation_id = ? AND direction = 'in' ORDER BY id DESC LIMIT 20`,
      )
      .all(last?.id ?? 0, n.id)
      .reverse()
      .map((r) => ({ text: r.text, after: r.after === 1 }));
    return {
      now,
      hour: new Date(now).getHours(),
      inFlight: this.inFlight(n.id) !== null,
      starts,
      startedToday,
      unansweredSince: last && !answered ? Date.parse(last.at) : null,
      seller,
    };
  }

  askMandate(n: Negotiation, before?: string): Approval {
    const reason = mandateReason(n, this.d.bots.nameOf(n.botId));
    const approval = this.d.approvals.create({
      taskId: null,
      botId: n.botId,
      conversationId: n.conversationId ?? undefined,
      kind: "mandate",
      summary: mandateSummary(n),
      reason: before ? `${before}\n\n${reason}` : reason,
    });
    this.update(n.id, { approval_id: approval.id });
    return approval;
  }

  async mandateDecided(a: Approval) {
    if (a.kind !== "mandate" || this.applying.has(a.id)) return;
    const [n] = this.negotiations(
      this.d.db
        .query<Row, [number]>(`${SELECT} WHERE n.approval_id = ? AND n.status = 'awaiting_mandate'`)
        .all(a.id),
    );
    if (!n || a.status === "pending") return;
    // The event and the minute tick can both bring it while Haiku applies the note.
    this.applying.add(a.id);
    try {
      await this.applyDecision(n, a);
    } finally {
      this.applying.delete(a.id);
    }
  }

  private async applyDecision(first: Negotiation, a: Approval) {
    let n = first;
    if (a.status !== "approved") {
      this.end(n.id, a.status === "expired" ? "expired" : "abandoned");
      return;
    }
    let mandate = n.mandate;
    // A note asked about again (it gave more room) still guides the opening message once approved.
    const earlier = this.mandateNote(n.id);
    const note = [earlier, a.note].filter(Boolean).join("\n") || null;
    if (a.note) {
      const applied = await applyNote(this.d, n, a.note, this.clock());
      // Stopped, closed or asked again while Haiku read the note: that stands.
      const now = this.get(n.id);
      if (now?.status !== "awaiting_mandate" || now.approvalId !== a.id) return;
      n = now;
      if ("error" in applied) {
        this.askMandate(
          n,
          `Your note couldn't be applied (${applied.error}), so the mandate is as it was. Your note: ${a.note}`,
        );
        return;
      }
      mandate = applied.mandate;
      // Haiku read the note: anything that gives more room than you approved comes back to you first.
      const more = widened(n, mandate);
      if (more.length) {
        this.update(n.id, { mandate: JSON.stringify({ ...mandate, note }) });
        this.askMandate(
          this.get(n.id) as Negotiation,
          `Your note gives it more room than before. Approve to go ahead with this, or deny to end the negotiation.\n${more.join("\n")}\nYour note: ${a.note}`,
        );
        return;
      }
    }
    this.update(n.id, {
      status: "open",
      mandate: JSON.stringify(note ? { ...mandate, note } : mandate),
      next_follow_up_at: this.nextSendAt(),
    });
    this.due();
  }

  private mandateNote(id: number): string | null {
    return (
      this.d.db
        .query<{ note: string | null }, [number]>(
          "SELECT json_extract(mandate, '$.note') AS note FROM negotiations WHERE id = ?",
        )
        .get(id)?.note ?? null
    );
  }

  private nextSendAt(): string {
    const now = new Date(this.clock());
    const h = now.getHours();
    if (h < QUIET_HOURS.from && h >= QUIET_HOURS.to) return now.toISOString();
    const at = new Date(now);
    if (h >= QUIET_HOURS.from) at.setDate(at.getDate() + 1);
    at.setHours(QUIET_HOURS.to, 0, 0, 0);
    return at.toISOString();
  }

  due() {
    if (this.d.tasks.paused()) return;
    // Decided while the brain was away. An approved hold needs nothing more.
    const waiting = this.d.db
      .query<{ approval_id: number }, []>(
        "SELECT approval_id FROM negotiations WHERE status IN ('awaiting_mandate', 'open') AND approval_id IS NOT NULL",
      )
      .all();
    for (const w of waiting) {
      const a = this.d.approvals.get(w.approval_id);
      if (
        a &&
        a.status !== "pending" &&
        !(a.kind === "injection_warning" && a.status === "approved")
      )
        this.decided(a);
    }
    const lapsed = this.d.db
      .query<{ id: number }, [string]>(
        "SELECT id FROM negotiations WHERE status = 'open' AND json_extract(mandate, '$.expiresAt') <= ?",
      )
      .all(this.now());
    for (const { id } of lapsed) this.end(id, "expired");
    const ready = this.d.db
      .query<Row, [string]>(
        `${SELECT} WHERE n.status = 'open' AND n.next_follow_up_at IS NOT NULL AND n.next_follow_up_at <= ?`,
      )
      .all(this.now());
    for (const n of this.negotiations(ready)) {
      this.update(n.id, { next_follow_up_at: null });
      if (this.facts(n).starts) this.startOpening(n);
    }
  }

  private startOpening(n: Negotiation) {
    const approval = n.approvalId ? this.d.approvals.get(n.approvalId) : null;
    // Opened before the note was kept beside the mandate: the approval's own.
    const note = this.mandateNote(n.id) ?? (approval?.kind === "mandate" ? approval.note : null);
    const card = this.d.db
      .query<{ id: number }, [number]>("SELECT id FROM messages WHERE negotiation_id = ? LIMIT 1")
      .get(n.id)?.id;
    this.d.tasks.createBackgroundTask({
      title: `Open negotiation #${n.id}: ${n.title}`.slice(0, 80),
      goal: openingGoal(n, note),
      origin: "chat",
      botId: n.botId,
      conversationId: n.conversationId ?? undefined,
      message: card,
      runKey: `negotiation:${n.id}`,
      // The listing's title is the seller's words, so it isn't among the owner's.
      request: `The owner approved the mandate for negotiation #${n.id} (${n.listingUrl}): ${mandateAims(n)}.${note ? `\nTheir note on it: ${note}` : ""}`,
    });
  }

  /** An older desktop-agent can't run the exact-text check. */
  async desktopReady() {
    const s = await this.d.desktop.agent.status().catch(() => null);
    if (!s) throw new PluginError("The desktop isn't answering, so nothing can be sent or read.");
    if (!s.features?.includes("fields"))
      throw new PluginError(
        "desktop-agent is older than the brain and can't check a message before it goes. The owner needs to run Update first.",
      );
  }

  async send(
    n: Negotiation,
    input: SendInput,
    call: CallContext,
    claimed: number | null = null,
  ): Promise<string> {
    const text = collapse(input.text);
    const msg = claimed ?? this.claimSend(n, input);
    const task = this.desktopTask(n, call, {
      title: `Message the seller: ${n.title}`.slice(0, 80),
      goal: sendGoal(n, text),
      successCriteria: "The message shows in the conversation as sent.",
      messageId: msg,
    });
    this.update(n.id, {});
    if (!call.waitForTask)
      return `Sending it in desktop task #${task.id}, which shows under your reply. You'll hear how it went.`;
    const ended = await call.waitForTask(task.id);
    return this.sendOutcome(n.id, msg, ended);
  }

  /** Blocks a second send in the negotiation: call it right after the policy, before anything waits. */
  claimSend(n: Negotiation, input: SendInput): number {
    const msg = this.d.db
      .query<{ id: number }, (string | number | null)[]>(
        `INSERT INTO negotiation_messages (negotiation_id, direction, text, offer, agree, stated, status, created_at)
         VALUES (?, 'out', ?, ?, ?, ?, 'sending', ?) RETURNING id`,
      )
      .get(
        n.id,
        collapse(input.text),
        input.offer,
        input.agree ? 1 : 0,
        input.stated ? JSON.stringify(input.stated) : null,
        this.now(),
      )?.id;
    if (!msg) throw new Error("message insert failed");
    return msg;
  }

  dropSend(messageId: number) {
    this.setStatus(messageId, "failed");
  }

  async check(n: Negotiation, call: CallContext): Promise<string> {
    const task = this.desktopTask(n, call, {
      title: `Read the seller's messages: ${n.title}`.slice(0, 80),
      goal: readGoal(n),
      successCriteria: "Every message in the conversation is recorded.",
      messageId: null,
    });
    if (!call.waitForTask)
      return `Reading the conversation in desktop task #${task.id}, which shows under your reply. You'll hear what the seller said.`;
    const before = this.messages(n.id).length;
    const ended = await call.waitForTask(task.id);
    const fresh = this.messages(n.id)
      .slice(before)
      .filter((m) => m.direction === "in");
    const head = `Desktop task #${ended.id} ended: ${ended.status}.`;
    const latest = this.get(n.id);
    const held = latest ? this.held(latest) : null;
    return `${
      fresh.length
        ? `${head} New from the seller:\n${fresh.map((m) => `- ${m.text}`).join("\n")}`
        : `${head} Nothing new from the seller.`
    }${held ? `\n${held}` : ""}`;
  }

  private desktopTask(
    n: Negotiation,
    call: CallContext,
    input: { title: string; goal: string; successCriteria: string; messageId: number | null },
  ): Task {
    const parent = call.task ? (this.d.tasks.get(call.task.id) ?? undefined) : undefined;
    const task = this.d.tasks.createDesktopTask({
      title: input.title,
      goal: input.goal,
      successCriteria: input.successCriteria,
      origin: parent?.origin ?? "chat",
      parent,
      message: parent ? undefined : call.messageId,
      botId: n.botId,
      conversationId: parent ? undefined : (n.conversationId ?? undefined),
      // Before it runs: its gate comes from this row.
      created: (id) =>
        this.d.db
          .query(
            "INSERT INTO negotiation_tasks (task_id, negotiation_id, message_id) VALUES (?, ?, ?)",
          )
          .run(id, n.id, input.messageId),
    });
    return task;
  }

  private sendOutcome(negotiationId: number, messageId: number, ended: Task): string {
    const m = this.message(messageId);
    const fresh = this.messages(negotiationId).filter(
      (x) => x.direction === "in" && x.id > messageId,
    );
    const n = this.get(negotiationId);
    const held = n ? this.held(n) : null;
    const replies = `${
      fresh.length
        ? `\nThe seller wrote meanwhile:\n${fresh.map((x) => `- ${x.text}`).join("\n")}`
        : ""
    }${held ? `\n${held}` : ""}`;
    switch (m?.status) {
      case "sent":
        return `Sent.${replies}`;
      case "unconfirmed":
        return `Send was clicked, but the text stayed in the box, so it may not have gone. Don't send it again before negotiate_check shows whether it did.${replies}`;
      default:
        return `Not sent. Desktop task #${ended.id} ended: ${ended.status}: ${ended.summary ?? ""}${replies}`;
    }
  }

  gateFor(taskId: number): SendGate | null {
    const r = this.d.db
      .query<
        {
          message_id: number | null;
          text: string | null;
          listing_url: string;
          listing_key: string;
          conversation_url: string | null;
        },
        [number]
      >(
        `SELECT nt.message_id, m.text, n.listing_url, n.listing_key, n.conversation_url
         FROM negotiation_tasks nt JOIN negotiations n ON n.id = nt.negotiation_id
         LEFT JOIN negotiation_messages m ON m.id = nt.message_id WHERE nt.task_id = ?`,
      )
      .get(taskId);
    if (!r) return null;
    const send = r.message_id !== null && this.sendStopped(taskId) === null;
    return {
      mode: send ? "send" : "read",
      text: send ? r.text : null,
      listingUrl: r.listing_url,
      listingId: parseKey(r.listing_key)?.id ?? "",
      conversationUrl: r.conversation_url,
    };
  }

  sendStopped(taskId: number): string | null {
    const row = this.taskRow(taskId);
    const n = row && this.get(row.negotiation_id);
    if (!n) return null;
    if (n.status !== "open") return `Negotiation #${n.id} is ${n.status}: nothing more is sent.`;
    if (Date.parse(n.mandate.expiresAt) <= this.clock())
      return `Negotiation #${n.id}'s mandate ran out: nothing more is sent.`;
    return this.held(n);
  }

  held(n: Negotiation): string | null {
    if (n.status !== "open" || !n.approvalId) return null;
    const a = this.d.approvals.get(n.approvalId);
    if (a?.kind !== "injection_warning" || a.status !== "pending") return null;
    return `Negotiation #${n.id} is held: the seller's message looked like a scam, and the owner decides whether to carry on. Don't reply to the seller, open anything they sent, or close the negotiation; wait for the owner.`;
  }

  private hold(n: Negotiation, text: string, signals: string[]) {
    const quoted = text.length > 500 ? `${text.slice(0, 499)}…` : text;
    const approval = this.d.approvals.create({
      taskId: null,
      botId: n.botId,
      conversationId: n.conversationId ?? undefined,
      kind: "injection_warning",
      summary: `Keep negotiating for ${quotedTitle(n.title)}?`,
      reason: `The seller wrote: “${quoted}”\nIt has ${signals.join("; ")}, which is how scams on marketplaces often start. Nothing more goes to the seller until you decide. Approve to carry on, or deny to end the negotiation.`,
    });
    this.update(n.id, { approval_id: approval.id });
  }

  async holdDecided(a: Approval) {
    const [n] = this.negotiations(
      this.d.db
        .query<Row, [number]>(`${SELECT} WHERE n.approval_id = ? AND n.status = 'open'`)
        .all(a.id),
    );
    if (!n || a.status === "pending") return;
    if (a.status === "approved") return this.emit(n.id);
    await this.close(
      n,
      "abandoned",
      null,
      a.status === "denied"
        ? "The seller's message looked like a scam, and the owner ended it."
        : "The seller's message looked like a scam, and nobody said to carry on.",
    );
  }

  /** `except` is the task asking, which carries on with the tasks above it. */
  stopTasks(id: number, except: number | null = null) {
    const keep = new Set<number>();
    for (let t = except === null ? null : this.d.tasks.get(except); t; ) {
      keep.add(t.id);
      t = t.parentId ? this.d.tasks.get(t.parentId) : null;
    }
    const ids = this.d.db
      .query<{ task_id: number }, [number]>(
        `SELECT nt.task_id FROM negotiation_tasks nt JOIN tasks t ON t.id = nt.task_id
         WHERE nt.negotiation_id = ? AND t.status NOT IN ('done', 'failed', 'cancelled')`,
      )
      .all(id)
      .map((r) => r.task_id);
    const opening = this.d.tasks.activeFor(`negotiation:${id}`);
    if (opening) ids.push(opening.id);
    for (const t of ids) if (!keep.has(t)) this.d.tasks.cancel(t);
  }

  private taskRow(taskId: number) {
    return this.d.db
      .query<{ negotiation_id: number; message_id: number | null }, [number]>(
        "SELECT negotiation_id, message_id FROM negotiation_tasks WHERE task_id = ?",
      )
      .get(taskId);
  }

  /** `stale`: the seller wrote since the message was approved, so it mustn't go. */
  record(
    taskId: number,
    tabUrl: string | null,
    report: ConversationReport,
    state: {
      sent: boolean;
      /** The approved text may be a draft in the box. */
      typed?: boolean;
      drafts?: string[];
      pageText?: string | null;
    },
  ): Recorded {
    const row = this.taskRow(taskId);
    const n = row && this.get(row.negotiation_id);
    if (!row || !n)
      return { text: "This task has no negotiation.", stale: false, alreadySent: false };
    const stored = new Map<string, number>();
    for (const m of this.messages(n.id))
      if (m.direction === "in") stored.set(keyOf(m.text), (stored.get(keyOf(m.text)) ?? 0) + 1);
    const outgoing = row.message_id ? this.message(row.message_id) : null;
    // The same words sent earlier in this negotiation don't show this one went.
    const sentBefore = new Set(
      this.messages(n.id)
        .filter((m) => m.direction === "out" && m.id !== outgoing?.id && m.status !== "failed")
        .map((m) => keyOf(m.text)),
    );
    const lastOurs = report.findLastIndex((m) => m.from === "us");
    const drafts = new Set((state.drafts ?? []).map(keyOf));
    let added = 0;
    let after = 0;
    let alreadySent = false;
    report.forEach((m, i) => {
      const key = keyOf(m.text);
      if (!key) return;
      if (m.from === "us") {
        if (
          outgoing &&
          key === keyOf(outgoing.text) &&
          outgoing.status !== "sent" &&
          !sentBefore.has(key)
        ) {
          if (state.sent) this.setStatus(outgoing.id, "sent");
          // An earlier task's send shows, unless it's text typed here, or a draft still in the box.
          else if (!state.typed && !drafts.has(key)) {
            alreadySent = true;
            this.setStatus(outgoing.id, "sent");
          }
        }
        return;
      }
      const seen = stored.get(key) ?? 0;
      if (seen > 0) {
        stored.set(key, seen - 1);
        return;
      }
      const text = collapse(m.text).slice(0, 4000);
      this.d.db
        .query(
          `INSERT INTO negotiation_messages (negotiation_id, direction, text, status, created_at)
           VALUES (?, 'in', ?, 'received', ?)`,
        )
        .run(n.id, text, this.now());
      added++;
      if (i > lastOurs) after++;
      const signals = scamSignals(text, n.mandate.allow);
      // Only an open one: a mandate waiting for the owner keeps its approval, and a closed one is over.
      const current = signals.length ? this.get(n.id) : null;
      if (current?.status === "open" && !this.held(current)) this.hold(current, text, signals);
    });
    // Only a read records the conversation's address here; a send records where it went in sendPassed.
    const mode = row.message_id ? "send" : "read";
    if (tabUrl && !n.conversationUrl && mode === "read" && this.conversationFor(n, tabUrl))
      this.update(n.id, { conversation_url: tabUrl.split("#")[0] ?? tabUrl });
    else this.update(n.id, {});
    // Closed, or its mandate ran out, since the message was approved: it doesn't go either.
    const stopped = mode === "send" && !state.sent ? this.sendStopped(taskId) : null;
    const stale =
      mode === "send" &&
      !state.sent &&
      !alreadySent &&
      (after > 0 || stopped !== null) &&
      outgoing?.status === "sending";
    if (stale && outgoing) this.setStatus(outgoing.id, "failed");
    const got = added
      ? `Recorded ${added} new message${added === 1 ? "" : "s"} from the seller.`
      : "Nothing new from the seller.";
    const next = alreadySent
      ? "The approved message is in the conversation already: it went. Don't send it again; finish the task."
      : stale && after > 0
        ? "The seller wrote since this message was approved, so it isn't sent: don't send it. Finish the task, saying the seller wrote first."
        : stale
          ? `${stopped} Don't send it; finish the task.`
          : mode === "read" || state.sent
            ? "Finish the task now."
            : "Now type exactly the approved message into the message box and send it.";
    return { text: `${got} ${next}`, stale, alreadySent };
  }

  sendPassed(taskId: number, confirmed: boolean, tabUrl: string | null = null) {
    const row = this.taskRow(taskId);
    if (!row?.message_id) return;
    const m = this.message(row.message_id);
    if (m?.status !== "sending") return;
    const n = this.get(row.negotiation_id);
    if (
      confirmed &&
      tabUrl &&
      n &&
      !n.conversationUrl &&
      sameHost(tabUrl, n.listingUrl) &&
      !sameAddress(tabUrl, n.listingUrl)
    )
      this.d.db
        .query("UPDATE negotiations SET conversation_url = ? WHERE id = ?")
        .run(tabUrl.split("#")[0] ?? tabUrl, n.id);
    this.setStatus(row.message_id, confirmed ? "sent" : "unconfirmed");
  }

  // By the listing's id in the path: not the query, which the model can add to, nor the page's text,
  // where other conversations list their listings' titles.
  private conversationFor(n: Negotiation, url: string): boolean {
    return (
      !sameAddress(url, n.listingUrl) &&
      namesListing(url, n.listingUrl, parseKey(n.listingKey)?.id ?? "")
    );
  }

  private setStatus(messageId: number, status: NegotiationMessage["status"]) {
    const sent = status === "sent" || status === "unconfirmed";
    const before = this.message(messageId);
    // What it claimed stands once it may have gone: later messages keep to it.
    if (sent && before?.status === "sending" && before.stated) {
      const n = this.get(before.negotiationId);
      if (n)
        this.d.db
          .query("UPDATE negotiations SET claims = ? WHERE id = ?")
          .run(JSON.stringify(mergeClaims(n.claims, before.stated)), n.id);
    }
    this.d.db
      .query(
        "UPDATE negotiation_messages SET status = ?, sent_at = CASE WHEN ? THEN coalesce(sent_at, ?) ELSE sent_at END WHERE id = ?",
      )
      .run(status, sent ? 1 : 0, this.now(), messageId);
    if (before) this.update(before.negotiationId, {});
  }

  private taskEnded(task: Task) {
    const row = this.taskRow(task.id);
    if (!row) return;
    if (row.message_id && this.message(row.message_id)?.status === "sending")
      this.setStatus(row.message_id, "failed");
    else this.emit(row.negotiation_id);
  }

  /** False when it had ended already: a close approved after a Stop doesn't undo it. */
  private end(
    id: number,
    status: NegotiationStatus,
    price: number | null = null,
    from: number | null = null,
  ): boolean {
    const now = this.now();
    const ended = this.d.db
      .query(
        `UPDATE negotiations SET status = ?, agreed_price = ?, closed_at = ?, next_follow_up_at = NULL,
           updated_at = ? WHERE id = ? AND status IN (${OPEN})`,
      )
      .run(status, price, now, now, id).changes;
    if (!ended) return false;
    this.emit(id);
    // A send already queued mustn't go now.
    this.stopTasks(id, from);
    const approval = this.get(id)?.approvalId;
    if (approval && this.d.approvals.get(approval)?.status === "pending")
      this.d.approvals.cancel(approval);
    return true;
  }

  async close(
    n: Negotiation,
    outcome: "agreed" | "lost" | "abandoned",
    price: number | null,
    notes: string | null,
    from: number | null = null,
  ): Promise<string | null> {
    if (!this.end(n.id, outcome, price, from)) return null;
    if (outcome === "agreed")
      this.d.db.query("UPDATE wants SET status = 'agreed' WHERE id = ?").run(n.wantId);
    const lines = [
      `## ${this.now().slice(0, 10)} · ${n.title}`,
      `${n.listingKey} ${n.listingUrl}`,
      `${outcome}${price !== null ? ` at ${price} ${n.mandate.currency}` : ""}; asking ${n.asking ?? "?"}, opened ${n.mandate.opening}, aimed ${n.mandate.target}.`,
      ...(notes ? [notes.trim()] : []),
    ];
    const folder = botFolder(n.botId);
    const path = folder ? `${folder}/negotiations.md` : "negotiations.md";
    // Read and written in one go, so two closes at once both keep their notes.
    await this.d.memory.update(
      path,
      (current) => `${(current ?? "# Negotiations\n").trimEnd()}\n\n${lines.join("\n")}\n`,
      this.d.bots.author(n.botId),
      `Negotiation #${n.id}: ${outcome}`,
    );
    return path;
  }

  async stop(id: number): Promise<Negotiation | null> {
    const n = this.get(id);
    if (!n || !(await this.close(n, "abandoned", null, "Stopped by the owner."))) return null;
    return this.get(id);
  }

  /** The brain tells Scout the outcome, not the model. */
  async recordOutcome(
    available: PluginTool[],
    n: Negotiation,
    outcome: string,
    price: number | null,
  ): Promise<string | null> {
    const t = scoutTool(available, "scout_record_outcome");
    if (!t) return null;
    const input = {
      listingKey: n.listingKey,
      outcome,
      price,
      asking: n.asking,
      currency: n.mandate.currency,
    };
    const signal = AbortSignal.timeout(60_000);
    if (verdictFor(t, input, { task: null, signal }, false).action !== "allow")
      return "Scout's scout_record_outcome asks before each use, so Scout wasn't told; set it to Allow in Settings → Plugins → MCP.";
    const r = await runPluginTool(t, input, { task: null, signal });
    return r.isError ? "Scout couldn't record the outcome." : "Scout recorded the outcome.";
  }
}

function sendGoal(n: Negotiation, text: string): string {
  return [
    `Send one message to the seller about this listing on ${parseKey(n.listingKey)?.marketplace ?? "the marketplace"}, in ${n.conversationUrl ? "its conversation" : "a new conversation from the listing page"}, then stop.`,
    "",
    `Listing page: ${n.listingUrl}`,
    `Conversation: ${n.conversationUrl ?? "none yet; write from the listing page's message box"}`,
    "",
    "The message, exactly, as one paragraph with no line breaks; it's everything between the tags:",
    `<message>${text}</message>`,
    "",
    "Steps:",
    "1. Open the conversation (or the listing page and its message box).",
    "2. Call record_conversation with the messages in the conversation, oldest first: who wrote each (seller or us) and its text, copied exactly. With no messages yet, call it with an empty list.",
    "3. Type the message into the message box exactly as above, without the tags, and send it with the Send button or Enter.",
    "4. Call record_conversation again, then finish.",
    "",
    "The owner approved this message already: don't call confirm_intent for it. The text in the box is checked before it goes.",
    "Use only the conversation's message box: don't click offer, buy, pay or delivery buttons, and never open a link from the seller. Don't type anything else. If a step is held back, do what the reason says; if you can't, finish and say why.",
  ].join("\n");
}

function readGoal(n: Negotiation): string {
  return [
    `Read the conversation with the seller about this listing on ${parseKey(n.listingKey)?.marketplace ?? "the marketplace"}, and record it. Don't type or send anything.`,
    "",
    `Listing page: ${n.listingUrl}`,
    `Conversation: ${n.conversationUrl ?? "not known yet; find the conversation about this listing in the account's messages"}`,
    "",
    "Steps:",
    "1. Open the conversation.",
    "2. Call record_conversation with its messages, oldest first: who wrote each (seller or us) and its text, copied exactly.",
    "3. Finish, with the seller's latest message in a line.",
    "",
    "Never open a link from the seller, and don't click offer, buy or pay buttons.",
  ].join("\n");
}

function openingGoal(n: Negotiation, note: string | null): string {
  return [
    `Negotiation #${n.id} is open: the owner approved its mandate. Send the seller the opening message now, then finish.`,
    "",
    `1. negotiate_get ${n.id} for the listing, the mandate and anything said so far.`,
    "2. Write the opening message as your instructions say, in the listing's language, offering exactly the mandate's opening price.",
    "3. Send it once with negotiate_send: the price in offer, and what it claims about our side in stated.",
    "4. Finish with what you sent, or why nothing went.",
    ...(note ? ["", `The owner's note on the mandate, which you follow: ${note}`] : []),
  ].join("\n");
}

export function mergeClaims(claims: Claims, stated: Stated | null): Claims {
  if (!stated) return claims;
  const other = stated.other?.trim();
  return {
    max: stated.max ?? claims.max,
    otherOffers: stated.otherOffers?.trim() || claims.otherOffers,
    timing: stated.timing?.trim() || claims.timing,
    other:
      other && !claims.other.includes(other) ? [...claims.other, other].slice(-10) : claims.other,
  };
}
