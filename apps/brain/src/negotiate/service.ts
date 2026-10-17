// Negotiation (PLAN.md §16): wants, negotiations and their messages, the tools that drive them, and the
// desktop tasks that read a conversation or send one message in it. Scout's tools are called by name
// through the MCP plugin, as watchers call plugin tools.
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
import type { Chats } from "../agent/chats";
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
import { collapse, type SendGate, sameAddress, sameHost } from "./gate";
import { applyNote, mandateReason, mandateSummary } from "./mandate";
import { QUIET_HOURS, type SendFacts } from "./policy";
import { negotiateTools } from "./tools";

export type NegotiationsDeps = {
  db: Db;
  events: EventBus;
  tasks: Tasks;
  approvals: Approvals;
  chats: Chats;
  bots: Bots;
  memory: MemoryStore;
  desktop: Desktop;
  /** Haiku, for a note on a mandate. */
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

/** A message's words as the record compares them: letters and digits only, lowercased. */
const keyOf = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/** What the desktop model read in a conversation, oldest first. */
export type ConversationReport = { from: "seller" | "us"; text: string }[];

/** Its outcome, for the desktop model: what it may do next. */
export type Recorded = { text: string; stale: boolean; alreadySent: boolean };

const FINAL_TASK = ["done", "failed", "cancelled"];
/** Sends at most this long. */
export const MAX_TEXT = 1000;

export class Negotiations {
  readonly clock: () => number;

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
      if (e.type === "approval.resolved" && e.approval.kind === "mandate")
        void this.mandateDecided(e.approval).catch((err) =>
          console.error(`mandate approval ${e.approval.id} failed`, err),
        );
    });
  }

  now() {
    return new Date(this.clock()).toISOString();
  }

  get(id: number): Negotiation | null {
    const r = this.d.db.query<Row, [number]>(`${SELECT} WHERE n.id = ?`).get(id);
    return r ? this.toNegotiation(r) : null;
  }

  /** A bot's, or everyone's; newest first. */
  list(opts: { botId?: string; open?: boolean } = {}): Negotiation[] {
    const where: string[] = [];
    const args: string[] = [];
    if (opts.botId) {
      where.push("n.bot_id = ?");
      args.push(opts.botId);
    }
    if (opts.open !== undefined) {
      const statuses = OPEN_NEGOTIATION_STATUSES.map((s) => `'${s}'`).join(", ");
      where.push(`n.status ${opts.open ? "" : "NOT "}IN (${statuses})`);
    }
    return this.d.db
      .query<Row, string[]>(
        `${SELECT}${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY n.id DESC LIMIT 200`,
      )
      .all(...args)
      .map((r) => this.toNegotiation(r));
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

  private toNegotiation(r: Row): Negotiation {
    const last = this.d.db
      .query<MessageRow, [number]>(
        `${MESSAGE_SELECT} WHERE m.negotiation_id = ? AND m.status != 'failed' ORDER BY m.id DESC LIMIT 1`,
      )
      .get(r.id);
    return {
      id: r.id,
      botId: r.bot_id,
      wantId: r.want_id,
      want: r.want,
      role: r.role,
      listingKey: r.listing_key,
      listingUrl: r.listing_url,
      title: r.title,
      asking: r.asking,
      mandate: JSON.parse(r.mandate) as Mandate,
      appraisal: r.appraisal ? (JSON.parse(r.appraisal) as Appraisal) : null,
      conversationUrl: r.conversation_url,
      claims: { ...NO_CLAIMS, ...(JSON.parse(r.claims) as Partial<Claims>) },
      status: r.status,
      agreedPrice: r.agreed_price,
      approvalId: r.approval_id,
      conversationId: r.conversation_id,
      nextFollowUpAt: r.next_follow_up_at,
      lastMessage: last ? toMessage(last) : null,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      closedAt: r.closed_at,
    };
  }

  /** Changes columns of a negotiation and tells the clients. */
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

  /**
   * The negotiate tools for `bot`, given the plugin tools it has: none without Scout, whose
   * scout_listing_detail every negotiation starts from.
   */
  tools(bot: Bot, available: PluginTool[], where: { conversationId: number | null }): PluginTool[] {
    if (!scoutTool(available, "scout_listing_detail")) return [];
    return negotiateTools(this, bot, available, where);
  }

  /** One of the bot's own negotiations, or a PluginError the model can read. */
  mine(bot: Bot, id: number): Negotiation {
    const n = this.get(id);
    if (!n || n.botId !== bot.id) throw new PluginError(`There's no negotiation #${id}.`);
    return n;
  }

  /** A want to file a new negotiation under: an open one of the bot's, or a new one. */
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

  /** Makes a negotiation's record; its card goes under the reply that started it. */
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

  /** Shows a negotiation under a chat reply, as a task shows. */
  private attach(messageId: number, negotiationId: number) {
    const done = this.d.db
      .query(
        "UPDATE messages SET negotiation_id = ? WHERE id = ? AND negotiation_id IS NULL AND kind IN ('text', 'command')",
      )
      .run(negotiationId, messageId).changes;
    if (done) this.d.events.emit({ type: "message.negotiation", id: messageId, negotiationId });
  }

  /** An open negotiation already on this listing, or on this want, which N4's several sellers allow. */
  busy(listingKey: string, wantId: number): Negotiation | null {
    const statuses = OPEN_NEGOTIATION_STATUSES.map((s) => `'${s}'`).join(", ");
    const r = this.d.db
      .query<Row, [string, number]>(
        `${SELECT} WHERE n.status IN (${statuses}) AND (n.listing_key = ? OR n.want_id = ?) LIMIT 1`,
      )
      .get(listingKey, wantId);
    return r ? this.toNegotiation(r) : null;
  }

  /** The message being sent now, if any. */
  inFlight(id: number): { messageId: number; taskId: number | null } | null {
    const r = this.d.db
      .query<{ id: number; task_id: number | null }, [number]>(
        `SELECT m.id, (SELECT task_id FROM negotiation_tasks t WHERE t.message_id = m.id) AS task_id
         FROM negotiation_messages m WHERE m.negotiation_id = ? AND m.status = 'sending' LIMIT 1`,
      )
      .get(id);
    return r ? { messageId: r.id, taskId: r.task_id } : null;
  }

  /** A desktop task that's reading the conversation now, if any. */
  checking(id: number): number | null {
    const r = this.d.db
      .query<{ task_id: number }, [number]>(
        `SELECT nt.task_id FROM negotiation_tasks nt JOIN tasks t ON t.id = nt.task_id
         WHERE nt.negotiation_id = ? AND nt.message_id IS NULL
           AND t.status IN ('queued', 'running', 'waiting_approval', 'waiting_takeover') LIMIT 1`,
      )
      .get(id);
    return r?.task_id ?? null;
  }

  /** What negotiate_send's policy reads besides the negotiation: the clock and the pace so far. */
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
    return {
      now,
      hour: new Date(now).getHours(),
      inFlight: this.inFlight(n.id) !== null,
      starts,
      startedToday,
      unansweredSince: last && !answered ? Date.parse(last.at) : null,
    };
  }

  /** Asks the owner to approve the negotiation's mandate (PLAN.md §16.1); `before` says why again. */
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

  /**
   * The owner decided on a mandate. Approved: the negotiation opens, with the note's numbers if it had
   * one, and a task sends the opening message. Denied or cancelled: abandoned. Unanswered: expired.
   */
  async mandateDecided(a: Approval) {
    const r = this.d.db
      .query<Row, [number]>(`${SELECT} WHERE n.approval_id = ? AND n.status = 'awaiting_mandate'`)
      .get(a.id);
    if (!r) return;
    const n = this.toNegotiation(r);
    if (a.status === "pending") return;
    if (a.status !== "approved") {
      this.update(n.id, {
        status: a.status === "expired" ? "expired" : "abandoned",
        closed_at: this.now(),
      });
      return;
    }
    let mandate = n.mandate;
    if (a.note) {
      const applied = await applyNote(this.d, n, a.note, this.clock());
      if ("error" in applied) {
        this.askMandate(
          n,
          `Your note couldn't be applied (${applied.error}), so the mandate is as it was. Your note: ${a.note}`,
        );
        return;
      }
      mandate = applied.mandate;
    }
    this.update(n.id, {
      status: "open",
      mandate: JSON.stringify(mandate),
      next_follow_up_at: this.nextSendAt(),
    });
    this.due();
  }

  /** Now, or the end of quiet hours if it's within them. */
  private nextSendAt(): string {
    const now = new Date(this.clock());
    const h = now.getHours();
    if (h < QUIET_HOURS.from && h >= QUIET_HOURS.to) return now.toISOString();
    const at = new Date(now);
    if (h >= QUIET_HOURS.from) at.setDate(at.getDate() + 1);
    at.setHours(QUIET_HOURS.to, 0, 0, 0);
    return at.toISOString();
  }

  /**
   * Every minute: decisions on mandates the brain missed, and opening messages that are due. Nothing
   * else wakes a negotiation until N3's inbox poller.
   */
  due() {
    // Paused: nothing starts, and what's due waits for Resume.
    if (this.d.tasks.paused()) return;
    const waiting = this.d.db
      .query<{ approval_id: number }, []>(
        "SELECT approval_id FROM negotiations WHERE status = 'awaiting_mandate' AND approval_id IS NOT NULL",
      )
      .all();
    for (const w of waiting) {
      const a = this.d.approvals.get(w.approval_id);
      if (a && a.status !== "pending") void this.mandateDecided(a);
    }
    const ready = this.d.db
      .query<Row, [string]>(
        `${SELECT} WHERE n.status = 'open' AND n.next_follow_up_at IS NOT NULL AND n.next_follow_up_at <= ?`,
      )
      .all(this.now());
    for (const r of ready) {
      const n = this.toNegotiation(r);
      this.update(n.id, { next_follow_up_at: null });
      if (this.facts(n).starts) this.startOpening(n);
    }
  }

  /** The background task that writes and sends the opening message, under the reply that started it. */
  private startOpening(n: Negotiation) {
    const approval = n.approvalId ? this.d.approvals.get(n.approvalId) : null;
    const note = approval?.note ?? null;
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
      request: `The owner approved the mandate for negotiation #${n.id}: ${mandateSummary(n)}.${note ? `\nTheir note on it: ${note}` : ""}`,
    });
  }

  /** Throws unless the desktop can run the exact-text check: an older desktop-agent can't. */
  async desktopReady() {
    const s = await this.d.desktop.agent.status().catch(() => null);
    if (!s) throw new PluginError("The desktop isn't answering, so nothing can be sent or read.");
    if (!s.features?.includes("fields"))
      throw new PluginError(
        "desktop-agent is older than the brain and can't check a message before it goes. The owner needs to run Update first.",
      );
  }

  /**
   * Starts the desktop task that sends `text` in the negotiation's conversation, and nothing else. From
   * a task it waits for it; from the chat it shows under the reply.
   */
  async send(
    n: Negotiation,
    input: { text: string; offer: number | null; agree: boolean; stated: Stated | null },
    call: CallContext,
  ): Promise<string> {
    const text = collapse(input.text);
    const msg = this.d.db
      .query<{ id: number }, (string | number | null)[]>(
        `INSERT INTO negotiation_messages (negotiation_id, direction, text, offer, agree, stated, status, created_at)
         VALUES (?, 'out', ?, ?, ?, ?, 'sending', ?) RETURNING id`,
      )
      .get(
        n.id,
        text,
        input.offer,
        input.agree ? 1 : 0,
        input.stated ? JSON.stringify(input.stated) : null,
        this.now(),
      )?.id;
    if (!msg) throw new Error("message insert failed");
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

  /** Starts the desktop task that reads the conversation and records the seller's messages. */
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
    return fresh.length
      ? `${head} New from the seller:\n${fresh.map((m) => `- ${m.text}`).join("\n")}`
      : `${head} Nothing new from the seller.`;
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

  /** How a send went, for the task that waited for it. */
  private sendOutcome(negotiationId: number, messageId: number, ended: Task): string {
    const m = this.message(messageId);
    const fresh = this.messages(negotiationId).filter(
      (x) => x.direction === "in" && x.id > messageId,
    );
    const replies = fresh.length
      ? `\nThe seller wrote meanwhile:\n${fresh.map((x) => `- ${x.text}`).join("\n")}`
      : "";
    switch (m?.status) {
      case "sent":
        return `Sent.${replies}`;
      case "unconfirmed":
        return `Send was clicked, but the text stayed in the box, so it may not have gone. Don't send it again before negotiate_check shows whether it did.${replies}`;
      default:
        return `Not sent. Desktop task #${ended.id} ended: ${ended.status}: ${ended.summary ?? ""}${replies}`;
    }
  }

  /** What a negotiation's desktop task may do: send one message, or read. Null for other tasks. */
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
    return {
      mode: r.message_id ? "send" : "read",
      text: r.text,
      listingUrl: r.listing_url,
      listingId: parseKey(r.listing_key)?.id ?? "",
      conversationUrl: r.conversation_url,
    };
  }

  private taskRow(taskId: number) {
    return this.d.db
      .query<{ negotiation_id: number; message_id: number | null }, [number]>(
        "SELECT negotiation_id, message_id FROM negotiation_tasks WHERE task_id = ?",
      )
      .get(taskId);
  }

  /**
   * record_conversation: stores the seller's messages the desktop model read, and the conversation's
   * address. `stale`: the seller wrote since the message was approved, so it mustn't go.
   * `alreadySent`: the message is in the conversation already.
   */
  record(
    taskId: number,
    tabUrl: string | null,
    report: ConversationReport,
    state: { sent: boolean },
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
          alreadySent = !state.sent;
          this.setStatus(outgoing.id, "sent");
        }
        return;
      }
      const seen = stored.get(key) ?? 0;
      if (seen > 0) {
        stored.set(key, seen - 1);
        return;
      }
      this.d.db
        .query(
          `INSERT INTO negotiation_messages (negotiation_id, direction, text, status, created_at)
           VALUES (?, 'in', ?, 'received', ?)`,
        )
        .run(n.id, collapse(m.text).slice(0, 4000), this.now());
      added++;
      if (i > lastOurs) after++;
    });
    // The conversation's own address, once a message has gone there or a read found it.
    const mode = row.message_id ? "send" : "read";
    if (
      tabUrl &&
      !n.conversationUrl &&
      (mode === "read" || state.sent) &&
      sameHost(tabUrl, n.listingUrl) &&
      !sameAddress(tabUrl, n.listingUrl)
    )
      this.update(n.id, { conversation_url: tabUrl.split("#")[0] ?? tabUrl });
    else this.update(n.id, {});
    const stale =
      mode === "send" && !state.sent && !alreadySent && after > 0 && outgoing?.status === "sending";
    if (stale && outgoing) this.setStatus(outgoing.id, "failed");
    const got = added
      ? `Recorded ${added} new message${added === 1 ? "" : "s"} from the seller.`
      : "Nothing new from the seller.";
    if (alreadySent)
      return {
        text: `${got} The approved message is in the conversation already: it went. Don't send it again; finish the task.`,
        stale: false,
        alreadySent,
      };
    if (stale)
      return {
        text: `${got} The seller wrote since this message was approved, so it isn't sent: don't send it. Finish the task, saying the seller wrote first.`,
        stale,
        alreadySent,
      };
    if (mode === "read") return { text: `${got} Finish the task now.`, stale, alreadySent };
    return {
      text: state.sent
        ? `${got} Finish the task now.`
        : `${got} Now type exactly the approved message into the message box and send it.`,
      stale,
      alreadySent,
    };
  }

  /** The gate let the send through: whether the text then left the box. */
  sendPassed(taskId: number, confirmed: boolean) {
    const row = this.taskRow(taskId);
    if (!row?.message_id) return;
    const m = this.message(row.message_id);
    if (m?.status !== "sending") return;
    this.setStatus(row.message_id, confirmed ? "sent" : "unconfirmed");
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
    const n = this.d.db
      .query<{ negotiation_id: number }, [number]>(
        "SELECT negotiation_id FROM negotiation_messages WHERE id = ?",
      )
      .get(messageId)?.negotiation_id;
    if (n) this.update(n, {});
  }

  /** A send whose task ended without the gate passing it never went. */
  private taskEnded(task: Task) {
    const row = this.taskRow(task.id);
    if (!row) return;
    if (row.message_id && this.message(row.message_id)?.status === "sending")
      this.setStatus(row.message_id, "failed");
    else this.emit(row.negotiation_id);
  }

  /**
   * Ends a negotiation: its status and price, the want agreed when it is, and notes on the seller and
   * what worked in the bot's memory.
   */
  async close(
    bot: Bot,
    n: Negotiation,
    outcome: "agreed" | "lost" | "abandoned",
    price: number | null,
    notes: string | null,
  ): Promise<string> {
    const now = this.now();
    this.update(n.id, {
      status: outcome,
      agreed_price: price,
      closed_at: now,
      next_follow_up_at: null,
    });
    if (outcome === "agreed")
      this.d.db.query("UPDATE wants SET status = 'agreed' WHERE id = ?").run(n.wantId);
    // Its mandate no longer needs an answer.
    if (n.status === "awaiting_mandate" && n.approvalId) this.d.approvals.cancel(n.approvalId);
    const lines = [
      `## ${now.slice(0, 10)} · ${n.title}`,
      `${n.listingKey} ${n.listingUrl}`,
      `${outcome}${price !== null ? ` at ${price} ${n.mandate.currency}` : ""}; asking ${n.asking ?? "?"}, opened ${n.mandate.opening}, aimed ${n.mandate.target}, limit ${n.mandate.limit}.`,
      ...(notes ? [notes.trim()] : []),
    ];
    const folder = botFolder(bot.id);
    const path = folder ? `${folder}/negotiations.md` : "negotiations.md";
    const before = (await this.d.memory.exists(path))
      ? await this.d.memory.read(path)
      : "# Negotiations\n";
    const sha = await this.d.memory.write(
      path,
      `${before.trimEnd()}\n\n${lines.join("\n")}\n`,
      this.d.bots.author(bot.id),
      `Negotiation #${n.id}: ${outcome}`,
    );
    if (sha)
      this.d.events.emit({
        type: "memory.committed",
        sha,
        message: `Negotiation #${n.id}: ${outcome}`,
        author: this.d.bots.nameOf(bot.id),
      });
    return path;
  }

  /**
   * Tells Scout how it ended, through scout_record_outcome when Scout has it and lets it run without
   * asking. The brain fills it in, not the model. What to tell the model, or null.
   */
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

/** The send task's goal: the approved text, where, and the steps the gate expects. */
function sendGoal(n: Negotiation, text: string): string {
  return [
    `Send one message to the seller about this listing on ${parseKey(n.listingKey)?.marketplace ?? "the marketplace"}, in ${n.conversationUrl ? "its conversation" : "a new conversation from the listing page"}, then stop.`,
    "",
    `Listing: ${n.title}`,
    `Listing page: ${n.listingUrl}`,
    `Conversation: ${n.conversationUrl ?? "none yet; write from the listing page's message box"}`,
    "",
    "The message, exactly (one paragraph, no line breaks):",
    text,
    "",
    "Steps:",
    "1. Open the conversation (or the listing page and its message box).",
    "2. Call record_conversation with the messages in the conversation, oldest first: who wrote each (seller or us) and its text, copied exactly. With no messages yet, call it with an empty list.",
    "3. Type the message into the message box exactly as above, and send it with the Send button or Enter.",
    "4. Call record_conversation again, then finish.",
    "",
    "Use only the conversation's message box: don't click offer, buy, pay or delivery buttons, and never open a link from the seller. Don't type anything else. If a step is held back, do what the reason says; if you can't, finish and say why.",
  ].join("\n");
}

/** The read task's goal. */
function readGoal(n: Negotiation): string {
  return [
    `Read the conversation with the seller about this listing on ${parseKey(n.listingKey)?.marketplace ?? "the marketplace"}, and record it. Don't type or send anything.`,
    "",
    `Listing: ${n.title}`,
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

/** The opening task's goal, once the mandate is approved. */
function openingGoal(n: Negotiation, note: string | null): string {
  return [
    `Negotiation #${n.id} is open: the owner approved its mandate. Send the seller the opening message now, then finish.`,
    "",
    `1. negotiate_get ${n.id} for the listing, the mandate and anything said so far.`,
    "2. Write the opening message as your instructions say, in the listing's language, offering the opening price or near it.",
    "3. Send it once with negotiate_send: the price in offer, and what it claims about our side in stated.",
    "4. Finish with what you sent, or why nothing went.",
    ...(note ? ["", `The owner's note on the mandate, which you follow: ${note}`] : []),
  ].join("\n");
}

/** The claims so far with a message's merged in: the newest says what stands. */
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
