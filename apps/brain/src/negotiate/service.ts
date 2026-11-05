// Scout's tools are called by name through the MCP plugin, as watchers call plugin tools.

import type { DesktopService } from "@hatbot/plugin-desktop";
import {
  botFolder,
  type CallContext,
  clip,
  PluginError,
  type PluginTool,
} from "@hatbot/plugin-sdk";
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
import type { Bots } from "../bots";
import type { Db } from "../db";
import { UserError } from "../errors";
import type { EventBus } from "../events";
import type { MemoryStore } from "../memory/store";
import { runPluginTool, verdictFor } from "../plugins/registry";
import type { SettingsStore } from "../settings";
import type { Spend } from "../spend";
import type { Tasks } from "../tasks/service";
import { type ListingFacts, parseKey, scoutTool } from "./appraise";
import { askedIfBot } from "./bot-question";
import {
  collapse,
  NATIVE_OFFERS,
  namesListing,
  type SendGate,
  sameAddress,
  sameHost,
} from "./gate";
import {
  applyNote,
  groupReason,
  groupSummary,
  mandateAims,
  mandateReason,
  mandateSummary,
  quotedTitle,
  widened,
} from "./mandate";
import { marketplaceOf } from "./marketplace";
import {
  priceReading,
  QUIET_HOURS,
  quiet,
  type SendFacts,
  type SendInput,
  STALL_ROUNDS,
  stalled,
  zl,
} from "./policy";
import { disputed, scamSignals } from "./scam";
import {
  type BuyerConversation,
  listingText,
  type Posted,
  SOLD_NOTICE,
  saleGoal,
  saleMandate,
} from "./selling";
import { negotiateTools } from "./tools";

export type NegotiationsDeps = {
  db: Db;
  events: EventBus;
  tasks: Tasks;
  approvals: Approvals;
  bots: Bots;
  chats: Chats;
  memory: MemoryStore;
  desktop: () => DesktopService | null;
  model: ModelClient;
  spend: Spend;
  settings: SettingsStore;
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
  direction: NegotiationMessage["direction"];
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

/** Who's on the other side. */
const other = (n: Pick<Negotiation, "role">) => (n.role === "sell" ? "buyer" : "seller");

const keyOf = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/** `human`: the owner let the bot say it's a person, so a seller asking again holds nothing. */
type Hold = "scam" | "stalled" | "bot" | "human";
/** The bot hold's ready answer. */
export const SAY_HUMAN = "Say I'm human";
const HOLD_KINDS: Approval["kind"][] = ["injection_warning", "other"];
/** After a deal nothing more goes to the seller, so what they write is the owner's. */
const DEALT: NegotiationStatus[] = ["agreed", "paid", "received"];

/** `offer`: a card for an offer made with the site's offer button, at that price. */
export type ConversationReport = {
  from: "seller" | "buyer" | "us" | "site";
  text: string;
  offer?: number;
}[];

export type Recorded = { text: string; stale: boolean; alreadySent: boolean };

const FINAL_TASK = ["done", "failed", "cancelled"];
export const MAX_TEXT = 400;
/** A reply goes a short while after the seller's message, picked at random, rather than at once. */
export const replyPause = { minMs: 20_000, maxMs: 60_000, everyMs: 1000 };
/** How long a seller may leave our message unanswered before a nudge, and then before giving up. */
export const FOLLOW_UP_MS = 24 * 3600_000;
const MAX_NUDGES = 1;

/** A message as Scout's scout_conversation gives it. */
export type InboxMessage = {
  id: string;
  direction: "in" | "out";
  type: string;
  text: string;
  offer: { amount: number; status: string | null } | null;
};

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
        : HOLD_KINDS.includes(a.kind)
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
    role?: "buy" | "sell";
  }): Negotiation {
    const now = this.now();
    const id = this.d.db
      .query<{ id: number }, (string | number | null)[]>(
        `INSERT INTO negotiations (want_id, bot_id, conversation_id, role, listing_key, listing_url, title,
           asking, mandate, appraisal, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(
        input.wantId,
        input.bot.id,
        input.conversationId,
        input.role ?? "buy",
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
    const thread = this.openThread(this.get(id) as Negotiation);
    if (thread !== null) this.update(id, { conversation_id: thread });
    this.emit(id);
    return this.get(id) as Negotiation;
  }

  /**
   * Each negotiation talks to you in its own thread: its mandate, holds, tasks and the seller's
   * replies go there. Named by the want, not the listing's title, which is the seller's words, and
   * told apart from the want's other listings by marketplace and price.
   */
  private openThread(n: Negotiation): number | null {
    // A want left out takes the first listing's title.
    const first = this.d.db
      .query<{ title: string }, [number]>(
        "SELECT title FROM negotiations WHERE want_id = ? ORDER BY id LIMIT 1",
      )
      .get(n.wantId)?.title;
    const owners = first === undefined || n.want !== first.slice(0, 200);
    const market = parseKey(n.listingKey)?.marketplace || null;
    const price = n.asking !== null ? zl(n.asking, n.mandate.currency) : null;
    const where = [market, price].filter(Boolean).join(", ");
    const title = owners
      ? `${n.want.slice(0, 80)}${where ? ` · ${where}` : ""}`
      : market
        ? `${market} listing${price ? `, ${price}` : ""}`
        : `Negotiation #${n.id}`;
    try {
      return this.d.chats.openThread({
        botId: n.botId,
        title,
        message: `Negotiation #${n.id}, for ${n.listingUrl}: ${mandateAims(n)}. I'll ask you about it here and tell you here how it goes.`,
        key: `negotiation:${n.id}`,
      }).conversation.id;
    } catch (err) {
      if (err instanceof UserError) return null;
      throw err;
    }
  }

  /** A reply work shows under, if it's where the negotiation reports; else its card goes there. */
  private shownUnder(n: Negotiation, messageId: number | undefined): number | undefined {
    if (messageId === undefined) return undefined;
    const at = this.d.db
      .query<{ conversation_id: number }, [number]>(
        "SELECT conversation_id FROM messages WHERE id = ?",
      )
      .get(messageId)?.conversation_id;
    return at === (n.conversationId ?? undefined) ? messageId : undefined;
  }

  private attach(messageId: number, negotiationId: number) {
    const done = this.d.db
      .query(
        "UPDATE messages SET negotiation_id = ? WHERE id = ? AND negotiation_id IS NULL AND kind IN ('text', 'command')",
      )
      .run(negotiationId, messageId).changes;
    if (done) this.d.events.emit({ type: "message.negotiation", id: messageId, negotiationId });
  }

  busy(listingKey: string): Negotiation | null {
    const rows = this.d.db
      .query<Row, [string]>(`${SELECT} WHERE n.status IN (${OPEN}) AND n.listing_key = ? LIMIT 1`)
      .all(listingKey);
    return this.negotiations(rows)[0] ?? null;
  }

  openFor(wantId: number): number {
    return (
      this.d.db
        .query<{ c: number }, [number]>(
          `SELECT COUNT(*) AS c FROM negotiations WHERE want_id = ? AND status IN (${OPEN})`,
        )
        .get(wantId)?.c ?? 0
    );
  }

  /**
   * Another seller for the same want has a deal, or our agreement is on its way to them: the first
   * one holds, and nothing more goes to the others.
   */
  dealtElsewhere(n: Pick<Negotiation, "id" | "wantId">): number | null {
    return (
      this.d.db
        .query<{ id: number }, [number, number]>(
          `SELECT n.id FROM negotiations n WHERE n.want_id = ? AND n.id != ?
             AND (n.status IN ('agreed', 'paid', 'received') OR (n.status = 'open' AND EXISTS (
               SELECT 1 FROM negotiation_messages m WHERE m.negotiation_id = n.id AND m.direction = 'out'
                 AND m.agree = 1 AND m.status IN ('sending', 'sent', 'unconfirmed'))))
           ORDER BY n.id LIMIT 1`,
        )
        .get(n.wantId, n.id)?.id ?? null
    );
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
    // A buyer starts the conversation about our listing.
    const starts =
      n.role === "buy" &&
      !this.d.db
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
      dealtElsewhere: this.dealtElsewhere(n),
      starts,
      startedToday,
      unansweredSince: last && !answered ? Date.parse(last.at) : null,
      seller,
    };
  }

  askMandate(n: Negotiation, before?: string): Approval {
    return this.askMandates([n], before);
  }

  /**
   * One approval for several sellers started together. `from`: the chat they were started in, where it
   * waits, since each has its own thread; without one, their bot's chat.
   */
  askMandates(ns: Negotiation[], before?: string, from?: number | null): Approval {
    const [n] = ns;
    if (!n) throw new Error("no negotiation to ask about");
    const bot = this.d.bots.nameOf(n.botId);
    const reason = ns.length > 1 ? groupReason(ns, bot) : mandateReason(n, bot);
    const approval = this.d.approvals.create({
      taskId: null,
      botId: n.botId,
      conversationId:
        (ns.length > 1
          ? (from ?? this.d.chats.get(n.conversationId ?? 0)?.parentId)
          : n.conversationId) ?? undefined,
      kind: "mandate",
      summary: ns.length > 1 ? groupSummary(ns) : mandateSummary(n),
      reason: before ? `${before}\n\n${reason}` : reason,
    });
    for (const x of ns) this.update(x.id, { approval_id: approval.id });
    return approval;
  }

  /** Started without asking: its mandate stands as the bot set it. */
  begin(ns: Negotiation[]) {
    for (const n of ns) this.update(n.id, { status: "open", next_follow_up_at: this.nextSendAt() });
    this.due();
  }

  async mandateDecided(a: Approval) {
    if (a.kind !== "mandate" || this.applying.has(a.id) || a.status === "pending") return;
    const ns = this.negotiations(
      this.d.db
        .query<Row, [number]>(
          `${SELECT} WHERE n.approval_id = ? AND n.status = 'awaiting_mandate' ORDER BY n.id`,
        )
        .all(a.id),
    );
    if (!ns.length) return;
    // The event and the minute tick can both bring it while Haiku applies the note.
    this.applying.add(a.id);
    try {
      for (const n of ns) await this.applyDecision(n, a);
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

  private nextSendAt(ms = this.clock()): string {
    const now = new Date(ms);
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
      if (a && a.status !== "pending" && !(HOLD_KINDS.includes(a.kind) && a.status === "approved"))
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
      // Due still once the owner decides, or the task on it ends.
      if (this.held(n) || this.inFlight(n.id) || this.d.tasks.activeFor(`negotiation:${n.id}`))
        continue;
      this.update(n.id, { next_follow_up_at: null });
      const f = this.facts(n);
      if (f.starts) this.startOpening(n);
      else if (f.unansweredSince !== null) this.startFollowUp(n);
    }
    const unanswered = this.d.db
      .query<{ id: number }, []>(
        `SELECT n.id FROM negotiations n WHERE n.status = 'open'
           AND (SELECT direction FROM negotiation_messages WHERE negotiation_id = n.id AND status != 'failed'
                ORDER BY id DESC LIMIT 1) = 'in'
           AND (SELECT max(id) FROM negotiation_messages WHERE negotiation_id = n.id AND direction = 'in')
             > coalesce(n.woken_through, 0)`,
      )
      .all();
    for (const { id } of unanswered) this.wake(id);
    this.sendNotices();
  }

  /**
   * Starts a task that answers the seller's latest message, once for each message Scout read, unless
   * something is on the negotiation already. `again`: the owner let a held one carry on.
   */
  wake(id: number, again = false): Task | null {
    const n = this.get(id);
    if (n?.status !== "open" || this.d.tasks.paused() || this.held(n)) return null;
    if (this.inFlight(id) || this.checking(id) || this.dealtElsewhere(n) !== null) return null;
    // At night it waits for due() in the morning.
    if (Date.parse(n.mandate.expiresAt) <= this.clock() || quiet(new Date(this.clock()).getHours()))
      return null;
    const last = this.d.db
      .query<{ id: number; direction: string; woken: number | null }, [number]>(
        `SELECT m.id, m.direction, n.woken_through AS woken FROM negotiation_messages m
         JOIN negotiations n ON n.id = m.negotiation_id
         WHERE m.negotiation_id = ? AND m.status != 'failed' ORDER BY m.id DESC LIMIT 1`,
      )
      .get(id);
    if (last?.direction !== "in" || (!again && last.id <= (last.woken ?? 0))) return null;
    const selling = n.role === "sell";
    const task = this.d.tasks.createBackgroundTask({
      title: `Answer the ${selling ? "buyer" : "seller"}: ${n.title}`.slice(0, 80),
      goal: selling ? saleGoal(n) : replyGoal(n, this.mandateNote(n.id)),
      origin: "chat",
      botId: n.botId,
      conversationId: n.conversationId ?? undefined,
      runKey: `negotiation:${n.id}`,
      request: selling ? this.ownerListed(n) : this.ownerSaid(n),
    });
    if (task)
      this.d.db.query("UPDATE negotiations SET woken_through = ? WHERE id = ?").run(last.id, id);
    return task;
  }

  private startFollowUp(n: Negotiation) {
    const unanswered =
      this.d.db
        .query<{ c: number }, [number, number]>(
          `SELECT COUNT(*) AS c FROM negotiation_messages WHERE negotiation_id = ? AND direction = 'out'
             AND status IN ('sent', 'unconfirmed') AND id > coalesce((SELECT max(id) FROM negotiation_messages
               WHERE negotiation_id = ? AND direction = 'in'), 0)`,
        )
        .get(n.id, n.id)?.c ?? 0;
    this.d.tasks.createBackgroundTask({
      title: `${unanswered > MAX_NUDGES ? "Give up on" : "Nudge"} the seller: ${n.title}`.slice(
        0,
        80,
      ),
      goal: followUpGoal(n, unanswered > MAX_NUDGES),
      origin: "chat",
      botId: n.botId,
      conversationId: n.conversationId ?? undefined,
      runKey: `negotiation:${n.id}`,
      request: this.ownerSaid(n),
    });
  }

  /** What the owner approved, for the approval check: the listing's title is the seller's words. */
  private ownerSaid(n: Negotiation, note = this.mandateNote(n.id)): string {
    return `The owner approved the mandate for negotiation #${n.id} (${n.listingUrl}): ${mandateAims(n)}.${note ? `\nTheir note on it: ${note}` : ""}`;
  }

  private ownerListed(n: Negotiation): string {
    return `The owner marked this flip ready to list, and Hatbot posted it: ${n.listingUrl}. A buyer's messages about it are Haggler's to answer, selling at ${mandateAims(n)}.`;
  }

  /** Hatbot's listings that are up, the bot's on one marketplace, or all of them. */
  posted(where: { botId: string; channel: string } | { id: number }): Posted[] {
    type R = { id: number; flip_id: number; channel: string; url: string; draft: string };
    const rows =
      "id" in where
        ? this.d.db
            .query<R, [number]>(
              "SELECT id, flip_id, channel, url, draft FROM flip_listings WHERE id = ? AND url IS NOT NULL",
            )
            .all(where.id)
        : this.d.db
            .query<R, [string, string]>(
              "SELECT id, flip_id, channel, url, draft FROM flip_listings WHERE bot_id = ? AND channel = ? AND status = 'listed' AND url IS NOT NULL",
            )
            .all(where.botId, where.channel);
    return rows.map((r) => {
      const d = JSON.parse(r.draft) as {
        title: string;
        description: string;
        condition: string | null;
        delivery: { shipping: boolean; pickup: boolean };
        prices: Record<string, number>;
        currency: string;
      };
      return {
        id: r.id,
        flipId: r.flip_id,
        channel: r.channel,
        url: r.url,
        title: d.title,
        description: d.description,
        condition: d.condition,
        delivery: d.delivery,
        asking: d.prices[r.channel] ?? null,
        currency: d.currency,
      };
    });
  }

  saleListing(n: Negotiation): string | null {
    const id = this.d.db
      .query<{ id: number | null }, [number]>(
        "SELECT flip_listing_id AS id FROM negotiations WHERE id = ?",
      )
      .get(n.id)?.id;
    const p = id ? this.posted({ id })[0] : null;
    return p ? listingText(p) : null;
  }

  /** Sold or agreed already: no more buyers for it. */
  soldHere(flipId: number): boolean {
    return !!this.d.db
      .query<{ id: number }, [number]>(
        `SELECT n.id FROM negotiations n JOIN flip_listings f ON f.id = n.flip_listing_id
         WHERE f.flip_id = ? AND n.status IN ('agreed', 'paid', 'received') LIMIT 1`,
      )
      .get(flipId);
  }

  /** The negotiation following a buyer's conversation, if one does. */
  forConversation(conversationId: string): number | null {
    return (
      this.d.db
        .query<{ id: number }, [string]>(
          "SELECT id FROM negotiations WHERE inbox_conversation = ? ORDER BY id DESC LIMIT 1",
        )
        .get(conversationId)?.id ?? null
    );
  }

  /**
   * A buyer wrote about a listing Hatbot posted: a negotiation for them, open at once, since marking
   * the flip ready was the owner's go-ahead. Every buyer of one flip shares its want, so the first
   * agreement ends the others.
   */
  openSale(input: {
    bot: Bot;
    posted: Posted;
    asking: number;
    conversation: BuyerConversation;
    breakEven: number | null;
  }): Negotiation {
    const { bot, posted: p, conversation: c } = input;
    const want =
      this.d.db
        .query<{ id: number }, [number]>(
          `SELECT w.id FROM negotiations n JOIN flip_listings f ON f.id = n.flip_listing_id
           JOIN wants w ON w.id = n.want_id WHERE f.flip_id = ? AND w.status = 'open' LIMIT 1`,
        )
        .get(p.flipId)?.id ?? this.wantFor(bot, `Sell ${p.title}`, p.title);
    const n = this.create({
      bot,
      wantId: want,
      role: "sell",
      listing: {
        key: c.listingKey ?? `${p.channel}:flip-${p.flipId}`,
        marketplace: p.channel,
        title: p.title,
        url: p.url,
        asking: input.asking,
        currency: p.currency,
        typical: null,
        watchId: null,
        negotiable: true,
        listedAt: null,
        history: [],
      },
      mandate: saleMandate(
        p,
        input.asking,
        input.breakEven,
        this.d.settings.get().saleMarginPct,
        this.clock(),
      ),
      appraisal: null,
      status: "open",
      conversationId: null,
    });
    this.update(n.id, {
      flip_listing_id: p.id,
      inbox_conversation: c.id,
      // Scout's address for it, kept only on the listing's own site.
      conversation_url: c.url && sameHost(c.url, p.url) ? c.url : null,
    });
    return this.get(n.id) as Negotiation;
  }

  /**
   * After the sale: Scout records it, and the owner hears what to do. The other buyers' "it's sold"
   * went out when the others closed.
   */
  async sold(available: PluginTool[], n: Negotiation, price: number): Promise<string> {
    const flip = this.d.db
      .query<{ flip_id: number; channel: string }, [number]>(
        `SELECT f.flip_id, f.channel FROM negotiations n JOIN flip_listings f ON f.id = n.flip_listing_id
         WHERE n.id = ?`,
      )
      .get(n.id);
    if (!flip) return "";
    const elsewhere = this.d.db
      .query<{ channel: string }, [number, number]>(
        "SELECT channel FROM flip_listings WHERE flip_id = ? AND id != (SELECT flip_listing_id FROM negotiations WHERE id = ?) AND status = 'listed'",
      )
      .all(flip.flip_id, n.id)
      .map((r) => r.channel);
    const t = scoutTool(available, "scout_flip_update");
    const input = {
      id: flip.flip_id,
      soldOn: this.now().slice(0, 10),
      saleChannel: flip.channel,
      salePrice: price,
    };
    let scout = "Scout isn't connected, so the sale isn't recorded there.";
    if (t) {
      const signal = AbortSignal.timeout(60_000);
      if (verdictFor(t, input, { task: null, signal }, false).action !== "allow")
        scout =
          "Scout's scout_flip_update asks before each use, so the sale isn't recorded there; set it to Allow in Settings → Plugins → MCP.";
      else {
        const r = await runPluginTool(t, input, { task: null, signal }).catch(() => null);
        scout = r && !r.isError ? "Scout has the sale." : "Scout couldn't record the sale.";
      }
    }
    // With the sale in Scout, the listings come down by themselves (listings/service.ts).
    const takenDown =
      scout === "Scout has the sale." && !!scoutTool(available, "scout_flips_to_take_down");
    const others = elsewhere.join(" and ");
    this.d.chats.note(
      n.botId,
      `**Sold** ${quotedTitle(n.title)} on ${flip.channel} for ${zl(price, n.mandate.currency)} (negotiation #${n.id}). The buyer pays on the site; send it or hand it over once they have.${elsewhere.length ? (takenDown ? ` Taking it off ${others} next.` : ` Take it off ${others}.`) : ""} ${scout}`,
    );
    return scout;
  }

  private queueNotice(n: Negotiation) {
    this.d.db
      .query(
        `INSERT INTO negotiation_messages (negotiation_id, direction, text, status, notice, created_at)
         VALUES (?, 'out', ?, 'sending', 1, ?)`,
      )
      .run(n.id, SOLD_NOTICE, this.now());
  }

  /** "It's sold" to the buyers who didn't get it, each in a desktop task of its own, outside the night. */
  private sendNotices() {
    if (!this.d.desktop() || quiet(new Date(this.clock()).getHours())) return;
    const due = this.d.db
      .query<{ id: number; negotiation_id: number }, []>(
        `SELECT m.id, m.negotiation_id FROM negotiation_messages m WHERE m.notice = 1 AND m.status = 'sending'
           AND NOT EXISTS (SELECT 1 FROM negotiation_tasks t WHERE t.message_id = m.id)`,
      )
      .all();
    for (const m of due) {
      const n = this.get(m.negotiation_id);
      if (!n) continue;
      this.desktopTask(
        n,
        { task: null, signal: AbortSignal.timeout(60_000) },
        {
          title: `Tell the buyer it's sold: ${n.title}`.slice(0, 80),
          goal: sendGoal(n, SOLD_NOTICE, null, false, false),
          successCriteria: "The message shows in the conversation as sent.",
          messageId: m.id,
        },
      );
    }
  }

  private isNotice(messageId: number | null): boolean {
    return (
      messageId !== null &&
      this.d.db
        .query<{ notice: number }, [number]>("SELECT notice FROM negotiation_messages WHERE id = ?")
        .get(messageId)?.notice === 1
    );
  }

  /** Open ones that have written to the seller or sell, and dealt ones for two weeks, whose other side may still write. */
  watched(): Negotiation[] {
    const rows = this.d.db
      .query<Row, [string]>(
        `${SELECT} WHERE (n.status = 'open' AND (n.role = 'sell' OR EXISTS (SELECT 1 FROM negotiation_messages m
           WHERE m.negotiation_id = n.id AND m.direction = 'out' AND m.status != 'failed')))
         OR (n.status IN ('agreed', 'paid', 'received') AND n.closed_at >= ?)`,
      )
      .all(new Date(this.clock() - 14 * 86_400_000).toISOString());
    return this.negotiations(rows);
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
      message: this.shownUnder(n, card),
      runKey: `negotiation:${n.id}`,
      request: this.ownerSaid(n, note),
    });
  }

  /** When a reply to the seller's latest message may go; null when there's nothing to reply to. */
  replyAt(n: Negotiation): number | null {
    const last = this.d.db
      .query<{ at: string }, [number]>(
        "SELECT created_at AS at FROM negotiation_messages WHERE negotiation_id = ? AND direction = 'in' ORDER BY id DESC LIMIT 1",
      )
      .get(n.id);
    const { minMs, maxMs } = replyPause;
    return last ? Date.parse(last.at) + minMs + Math.random() * (maxMs - minMs) : null;
  }

  async replyPause(n: Negotiation, signal: AbortSignal) {
    const until = this.replyAt(n) ?? 0;
    while (this.clock() < until) {
      signal.throwIfAborted();
      await Bun.sleep(Math.min(replyPause.everyMs, until - this.clock()));
    }
  }

  /** An older desktop-agent can't run the exact-text check. */
  async desktopReady() {
    const s = await this.d
      .desktop()
      ?.agent.status()
      .catch(() => null);
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
      goal: sendGoal(
        n,
        text,
        input.offer,
        input.offerOnly === true,
        input.agree && this.theirOffer(n.id) === input.offer,
      ),
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
        `INSERT INTO negotiation_messages (negotiation_id, direction, text, offer, agree, offer_only, stated, status, created_at)
         VALUES (?, 'out', ?, ?, ?, ?, ?, 'sending', ?) RETURNING id`,
      )
      .get(
        n.id,
        collapse(input.text),
        input.offer,
        input.agree ? 1 : 0,
        input.offerOnly && input.offer !== null ? 1 : 0,
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
    const held = latest ? (this.held(latest) ?? this.saysHuman(latest)) : null;
    const dealt =
      latest && DEALT.includes(latest.status)
        ? `Negotiation #${n.id} is ${latest.status}: don't answer the seller.${fresh.length ? " The owner has what they wrote." : ""}`
        : null;
    return `${
      fresh.length
        ? `${head} New from the seller:\n${fresh.map((m) => `- ${m.text}`).join("\n")}`
        : `${head} Nothing new from the seller.`
    }${held ? `\n${held}` : ""}${dealt ? `\n${dealt}` : ""}`;
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
      message: parent ? undefined : this.shownUnder(n, call.messageId),
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
          offer: number | null;
          agree: number | null;
          offer_only: number | null;
          negotiation_id: number;
          listing_url: string;
          listing_key: string;
          conversation_url: string | null;
        },
        [number]
      >(
        `SELECT nt.message_id, m.text, m.offer, m.agree, m.offer_only, n.id AS negotiation_id, n.listing_url, n.listing_key, n.conversation_url
         FROM negotiation_tasks nt JOIN negotiations n ON n.id = nt.negotiation_id
         LEFT JOIN negotiation_messages m ON m.id = nt.message_id WHERE nt.task_id = ?`,
      )
      .get(taskId);
    if (!r) return null;
    const send = r.message_id !== null && this.sendStopped(taskId) === null;
    const native = send && nativeOffer(r.listing_url);
    return {
      mode: send ? "send" : "read",
      text: send ? r.text : null,
      offer: native ? r.offer : null,
      offerOnly: native && r.offer_only === 1,
      accept:
        native && r.agree === 1 && r.offer !== null && this.theirOffer(r.negotiation_id) === r.offer
          ? r.offer
          : null,
      listingUrl: r.listing_url,
      listingId: parseKey(r.listing_key)?.id ?? "",
      conversationUrl: r.conversation_url,
    };
  }

  sendStopped(taskId: number): string | null {
    const row = this.taskRow(taskId);
    const n = row && this.get(row.negotiation_id);
    if (!n || this.isNotice(row.message_id)) return null;
    if (n.status !== "open") return `Negotiation #${n.id} is ${n.status}: nothing more is sent.`;
    if (Date.parse(n.mandate.expiresAt) <= this.clock())
      return `Negotiation #${n.id}'s mandate ran out: nothing more is sent.`;
    return this.held(n);
  }

  held(n: Negotiation): string | null {
    if (n.status !== "open" || !n.approvalId) return null;
    const a = this.d.approvals.get(n.approvalId);
    if (!a || !HOLD_KINDS.includes(a.kind) || a.status !== "pending") return null;
    const hold = this.holdOf(n.id);
    if (hold === "stalled")
      return `Negotiation #${n.id} is held: the seller hasn't moved in ${STALL_ROUNDS} rounds, and the owner decides whether to carry on. Don't message the seller; wait for the owner. If the seller sold it or took your offer, you may still close it.`;
    if (hold === "bot")
      return `Negotiation #${n.id} is held: the seller asked whether they're writing to a bot, which is the owner's to answer. Don't answer it or message the seller; wait for the owner. If the seller sold it, you may still close it.`;
    return `Negotiation #${n.id} is held: the seller's message looked like a scam, and the owner decides whether to carry on. Don't reply to the seller, open anything they sent, or close the negotiation; wait for the owner.`;
  }

  /** What the owner let the bot say about itself, for what it reads of the negotiation. */
  saysHuman(n: Negotiation): string | null {
    return this.holdOf(n.id) === "human"
      ? "The owner said you may tell the seller you're a person if they ask whether you're a bot."
      : null;
  }

  /** A scam warning waits for the owner, who ends it or carries on; closing would clear it. */
  scamHeld(n: Negotiation): string | null {
    return this.holdOf(n.id) === "scam" ? this.held(n) : null;
  }

  private holdOf(id: number): Hold {
    return (
      this.d.db
        .query<{ hold: Hold | null }, [number]>("SELECT hold FROM negotiations WHERE id = ?")
        .get(id)?.hold ?? "scam"
    );
  }

  private hold(n: Negotiation, text: string, signals: string[]) {
    const quoted = clip(text, 500);
    const approval = this.d.approvals.create({
      taskId: null,
      botId: n.botId,
      conversationId: n.conversationId ?? undefined,
      kind: "injection_warning",
      summary: `Keep negotiating for ${quotedTitle(n.title)}?`,
      reason: `The ${other(n)} wrote: “${quoted}”\nIt has ${signals.join("; ")}, which is how scams on marketplaces often start. Nothing more goes to the ${other(n)} until you decide. Approve to carry on, or deny to end the negotiation.`,
    });
    // A scam outranks a stall: the stall's question goes, after the row stops pointing at it.
    const stall = this.held(n) ? n.approvalId : null;
    this.update(n.id, { approval_id: approval.id, hold: "scam" });
    if (stall) this.d.approvals.cancel(stall);
  }

  /** A stall isn't a scam: it can be approved from anywhere. */
  private holdStalled(n: Negotiation, price: number, at: number) {
    const approval = this.d.approvals.create({
      taskId: null,
      botId: n.botId,
      conversationId: n.conversationId ?? undefined,
      kind: "other",
      summary: `Keep negotiating for ${quotedTitle(n.title)}?`,
      reason: `The ${other(n)} has kept to ${zl(price, n.mandate.currency)} for ${STALL_ROUNDS} rounds. Nothing more goes to them until you decide. Approve to carry on: an offer past the ${n.role === "sell" ? "floor" : "limit"} still asks you first, and you can tell ${this.d.bots.nameOf(n.botId)} in the chat to wait. Deny to walk away.`,
    });
    this.update(n.id, { approval_id: approval.id, hold: "stalled", stalled_at: at });
  }

  /** Like a stall it can be approved from anywhere, and like a scam it takes a stall's place. */
  private holdAsked(n: Negotiation, text: string) {
    const bot = this.d.bots.nameOf(n.botId);
    const approval = this.d.approvals.create({
      taskId: null,
      botId: n.botId,
      conversationId: n.conversationId ?? undefined,
      kind: "other",
      summary: `Keep negotiating for ${quotedTitle(n.title)}?`,
      reason: `The ${other(n)} asked whether they're writing to a bot: “${clip(text, 500)}”\nThat's yours to answer: ${SAY_HUMAN} lets ${bot} tell them it's a person, or reply to them on ${parseKey(n.listingKey)?.marketplace ?? "the marketplace"} yourself and ${bot} reads what you wrote. Nothing more goes to them from ${bot} until you decide. Approve to let ${bot} carry on without answering it, or deny to end the negotiation.`,
      answers: [SAY_HUMAN],
    });
    const before = this.held(n) ? n.approvalId : null;
    this.update(n.id, { approval_id: approval.id, hold: "bot" });
    if (before) this.d.approvals.cancel(before);
  }

  async holdDecided(a: Approval) {
    const [n] = this.negotiations(
      this.d.db
        .query<Row, [number]>(`${SELECT} WHERE n.approval_id = ? AND n.status = 'open'`)
        .all(a.id),
    );
    if (!n || a.status === "pending") return;
    const stall = this.holdOf(n.id) === "stalled";
    // Unanswered, a stall carries on: walking away is the owner's to say.
    if (a.status === "approved" && this.holdOf(n.id) === "bot" && a.note === SAY_HUMAN) {
      this.update(n.id, { approval_id: null, hold: "human" });
      this.wake(n.id, true);
      return;
    }
    if (a.status === "approved" || (stall && a.status === "expired")) {
      this.update(n.id, { approval_id: null });
      this.wake(n.id, true);
      return;
    }
    const why = stall
      ? `The ${other(n)} didn't move in ${STALL_ROUNDS} rounds`
      : this.holdOf(n.id) === "bot"
        ? `The ${other(n)} asked whether they were writing to a bot`
        : `The ${other(n)}'s message looked like a scam`;
    await this.close(
      n,
      "abandoned",
      null,
      a.status === "denied"
        ? `${why}, and the owner ended it.`
        : `${why}, and nobody said to carry on.`,
    );
  }

  /** The bot doesn't answer after a deal, so the owner hears what the seller wrote. */
  private afterDeal(n: Negotiation, texts: string[]) {
    const price = n.agreedPrice !== null ? ` at ${zl(n.agreedPrice, n.mandate.currency)}` : "";
    const quoted = texts.map((t) => `“${clip(t, 500)}”`).join("\n");
    const bot = this.d.bots.nameOf(n.botId);
    const who = other(n);
    const yours = texts.some(disputed)
      ? `It reads like a dispute. ${bot} doesn't answer ${who}s after a deal, so it's yours to sort out, through the marketplace's dispute process if it comes to that.`
      : `${bot} doesn't answer ${who}s after a deal, so it's yours to answer.`;
    this.d.chats.note(
      n.botId,
      `**Negotiation #${n.id}** (${quotedTitle(n.title)}, ${n.status}${price}): new from the ${who}:\n${quoted}\n${yours}`,
      `The ${who} in negotiation #${n.id}`,
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
    reported: ConversationReport,
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
    // Vinted opens every conversation with a note of its own, as if the seller had written.
    const report = reported.filter((m) => m.from !== "site");
    const stored = new Map<string, number>();
    const owners = new Map<string, number>();
    const bots: string[] = [];
    for (const m of this.messages(n.id)) {
      const k = keyOf(m.text);
      if (m.direction === "in") stored.set(k, (stored.get(k) ?? 0) + 1);
      else if (m.direction === "owner") owners.set(k, (owners.get(k) ?? 0) + 1);
      else bots.push(k);
    }
    // A page may cut a long message short, so the bot's own words, cut or whole, are still its.
    const botWrote = (k: string) =>
      bots.some((b) => b === k || (k.length >= 20 && (b.includes(k) || k.includes(b))));
    const outgoing = row.message_id ? this.message(row.message_id) : null;
    // The same words sent earlier in this negotiation don't show this one went.
    const sentBefore = new Set(
      this.messages(n.id)
        .filter((m) => m.direction === "out" && m.id !== outgoing?.id && m.status !== "failed")
        .map((m) => keyOf(m.text)),
    );
    // An offer through the site, in the page's words rather than the inbox's: by its price, which
    // the card gives, or failing that its text's one price.
    const offers = (direction: string) =>
      this.messages(n.id)
        .filter((m) => m.direction === direction && m.offer !== null && m.status !== "failed")
        .map((m) => m.offer as number);
    const [theirs, ours] = [offers("in"), offers("out")];
    const sameOffer = (pool: number[], m: ConversationReport[number]) => {
      const r = priceReading(n, m.text);
      const [one, ...more] = new Set(r.values);
      const price = m.offer ?? (more.length || r.unclear ? undefined : one);
      const i = price === undefined ? -1 : pool.findIndex((x) => Math.abs(x - price) < 0.005);
      if (i >= 0) pool.splice(i, 1);
      return i >= 0;
    };
    const lastOurs = report.findLastIndex((m) => m.from === "us");
    const drafts = new Set((state.drafts ?? []).map(keyOf));
    let added = 0;
    let after = 0;
    let alreadySent = false;
    const fresh: string[] = [];
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
        const had = owners.get(key) ?? 0;
        if (had > 0) owners.set(key, had - 1);
        else if (!botWrote(key) && !sameOffer(ours, m))
          this.d.db
            .query(
              `INSERT INTO negotiation_messages (negotiation_id, direction, text, status, created_at)
               VALUES (?, 'owner', ?, 'received', ?)`,
            )
            .run(n.id, collapse(m.text).slice(0, 4000), this.now());
        return;
      }
      const seen = stored.get(key) ?? 0;
      if (seen > 0) {
        stored.set(key, seen - 1);
        return;
      }
      if (sameOffer(theirs, m)) return;
      added++;
      fresh.push(this.received(n, m.text, null, m.offer ?? null));
      if (i > lastOurs) after++;
    });
    // Whoever had it read answers it.
    if (fresh.length)
      this.d.db
        .query(
          `UPDATE negotiations SET woken_through = (SELECT max(id) FROM negotiation_messages
             WHERE negotiation_id = ? AND direction = 'in') WHERE id = ?`,
        )
        .run(n.id, n.id);
    this.receivedAll(n, fresh);
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
      !this.isNotice(row.message_id) &&
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
            : outgoing?.offer != null && this.offerOnly(outgoing.id)
              ? "Now answer with the site's own button, as the goal says; type the message only where there's no such button."
              : "Now type exactly the approved message into the message box and send it.";
    return { text: `${got} ${next}`, stale, alreadySent };
  }

  /**
   * A seller's message, recorded and screened. `marketId`: the marketplace's id for it; `offer`: what
   * they offered through the site's own button, which its Accept button takes.
   */
  private received(
    n: Negotiation,
    raw: string,
    marketId: string | null = null,
    offer: number | null = null,
  ): string {
    const text = collapse(raw).slice(0, 4000);
    this.d.db
      .query(
        `INSERT INTO negotiation_messages (negotiation_id, direction, text, offer, status, market_id, created_at)
         VALUES (?, 'in', ?, ?, 'received', ?, ?)`,
      )
      .run(n.id, text, offer, marketId, this.now());
    const signals = scamSignals(text, n.mandate.allow);
    const asked = !signals.length && askedIfBot(text, n.title);
    // Only an open one: a mandate waiting for the owner keeps its approval, and a closed one is over.
    const current = signals.length || asked ? this.get(n.id) : null;
    if (current?.status !== "open" || this.scamHeld(current)) return text;
    if (signals.length) this.hold(current, text, signals);
    else if (
      this.holdOf(current.id) !== "human" &&
      !(this.held(current) && this.holdOf(current.id) === "bot")
    )
      this.holdAsked(current, text);
    return text;
  }

  private receivedAll(n: Negotiation, fresh: string[]) {
    if (fresh.length && DEALT.includes(n.status)) this.afterDeal(n, fresh);
    if (fresh.length) this.stallCheck(n.id);
  }

  /**
   * The conversation as Scout read it from the marketplace, oldest first. The seller's new messages
   * are recorded and screened like a desktop read's, and the bot is woken to answer them; a message
   * a desktop read recorded already gets its id, so neither records it twice.
   */
  recordInbox(id: number, messages: InboxMessage[]): number {
    const n = this.get(id);
    if (!n) return 0;
    type Stored = {
      id: number;
      direction: string;
      text: string;
      offer: number | null;
      status: string;
      market_id: string | null;
    };
    const rows = this.d.db
      .query<Stored, [number]>(
        "SELECT id, direction, text, offer, status, market_id FROM negotiation_messages WHERE negotiation_id = ? ORDER BY id",
      )
      .all(n.id);
    const known = new Set(rows.map((r) => r.market_id));
    const mark = (r: Stored, marketId: string) => {
      r.market_id = marketId;
      this.d.db
        .query("UPDATE negotiation_messages SET market_id = ? WHERE id = ?")
        .run(marketId, r.id);
    };
    const ours = (k: string) =>
      rows.some(
        (r) =>
          r.direction === "out" &&
          (keyOf(r.text) === k ||
            (k.length >= 20 && (keyOf(r.text).includes(k) || k.includes(keyOf(r.text))))),
      );
    const fresh: string[] = [];
    for (const m of messages) {
      // An answer to our offer through the site's own button is the seller's, though the offer is ours.
      const answer =
        m.direction === "out" && m.type === "offer" && m.offer ? offerAnswer(m.offer) : null;
      const marketId = answer ? `${m.id}:${m.offer?.status}` : m.id;
      if (known.has(marketId)) continue;
      if (answer) {
        known.add(marketId);
        fresh.push(this.received(n, answer, marketId));
        continue;
      }
      const text = inboxText(m);
      const k = keyOf(text);
      if (!k) continue;
      known.add(marketId);
      if (m.direction === "in") {
        const offer = m.type === "offer" ? (m.offer?.amount ?? null) : null;
        const same = rows.find(
          (r) =>
            r.direction === "in" &&
            r.market_id === null &&
            (keyOf(r.text) === k || (offer !== null && r.offer === offer)),
        );
        if (same) {
          mark(same, marketId);
          if (offer !== null)
            this.d.db
              .query("UPDATE negotiation_messages SET offer = ? WHERE id = ?")
              .run(offer, same.id);
        } else fresh.push(this.received(n, text, marketId, offer));
        continue;
      }
      // Our own offer through the site's button: its message already says it.
      if (
        m.type === "offer" &&
        rows.some((r) => r.direction === "out" && r.offer === m.offer?.amount)
      )
        continue;
      const same = rows.find(
        (r) =>
          (r.direction === "out" || r.direction === "owner") &&
          r.market_id === null &&
          r.status !== "failed" &&
          keyOf(r.text) === k,
      );
      if (same) {
        mark(same, marketId);
        if (same.status === "unconfirmed") this.setStatus(same.id, "sent");
      } else if (!ours(k))
        this.d.db
          .query(
            `INSERT INTO negotiation_messages (negotiation_id, direction, text, status, market_id, created_at)
             VALUES (?, 'owner', ?, 'received', ?, ?)`,
          )
          .run(n.id, text.slice(0, 4000), marketId, this.now());
    }
    this.receivedAll(n, fresh);
    this.update(n.id, {});
    if (fresh.length) this.wake(n.id);
    return fresh.length;
  }

  private stallCheck(id: number) {
    const n = this.get(id);
    if (n?.status !== "open" || this.held(n)) return;
    const since =
      this.d.db
        .query<{ at: number | null }, [number]>(
          "SELECT stalled_at AS at FROM negotiations WHERE id = ?",
        )
        .get(id)?.at ?? null;
    const messages = this.messages(id);
    const price = stalled(n, messages, since);
    const last = messages.at(-1);
    if (price !== null && last) this.holdStalled(n, price, last.id);
  }

  /** The latest price the other side offered through the site's own button. */
  theirOffer(negotiationId: number): number | null {
    return (
      this.d.db
        .query<{ offer: number }, [number]>(
          "SELECT offer FROM negotiation_messages WHERE negotiation_id = ? AND direction = 'in' AND offer IS NOT NULL ORDER BY id DESC LIMIT 1",
        )
        .get(negotiationId)?.offer ?? null
    );
  }

  private offerOnly(messageId: number): boolean {
    return (
      this.d.db
        .query<{ offer_only: number }, [number]>(
          "SELECT offer_only FROM negotiation_messages WHERE id = ?",
        )
        .get(messageId)?.offer_only === 1
    );
  }

  /** The site's offer or Accept button went in place of the message, which says so from now on. */
  offerPassed(taskId: number, confirmed: boolean, tabUrl: string | null, how: "offer" | "accept") {
    const row = this.taskRow(taskId);
    const m = row?.message_id ? this.message(row.message_id) : null;
    const n = row && this.get(row.negotiation_id);
    if (!row?.message_id || !m || m.offer === null || !n) return;
    if (!this.offerOnly(m.id)) return;
    // In digits alone, as the price checks read them.
    const price = `${m.offer} ${n.mandate.currency === "PLN" ? "zł" : n.mandate.currency}`;
    this.d.db
      .query("UPDATE negotiation_messages SET text = ? WHERE id = ?")
      .run(
        how === "accept"
          ? `(Accepted their offer of ${price} through the site.)`
          : `(An offer through the site: ${price}.)`,
        m.id,
      );
    this.sendPassed(taskId, confirmed, tabUrl);
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

  conversationOpened(taskId: number, url: string) {
    const row = this.taskRow(taskId);
    if (row && !this.get(row.negotiation_id)?.conversationUrl)
      this.update(row.negotiation_id, { conversation_url: url });
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
    if (sent && before?.status === "sending" && before.direction === "out")
      this.d.db
        .query(
          "UPDATE negotiations SET next_follow_up_at = ? WHERE id = ? AND status = 'open' AND role = 'buy'",
        )
        .run(this.nextSendAt(this.clock() + FOLLOW_UP_MS), before.negotiationId);
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
    const n = this.get(id);
    const thread = n?.conversationId && this.d.chats.get(n.conversationId);
    if (n && thread && thread.kind === "thread")
      this.d.chats.resolveThread(
        thread.id,
        price === null ? status : `${status} at ${zl(price, n.mandate.currency)}`,
        true,
      );
    // A send already queued mustn't go now.
    this.stopTasks(id, from);
    const approval = this.get(id)?.approvalId;
    // A mandate shared with sellers still waiting on it stays for them.
    const shared =
      approval &&
      this.d.db
        .query<{ id: number }, [number]>(
          "SELECT id FROM negotiations WHERE approval_id = ? AND status = 'awaiting_mandate' LIMIT 1",
        )
        .get(approval);
    if (approval && !shared && this.d.approvals.get(approval)?.status === "pending")
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
    if (outcome === "agreed") {
      this.d.db.query("UPDATE wants SET status = 'agreed' WHERE id = ?").run(n.wantId);
      const others = this.d.db
        .query<Row, [number, number]>(
          `${SELECT} WHERE n.want_id = ? AND n.id != ? AND n.status IN (${OPEN})`,
        )
        .all(n.wantId, n.id);
      for (const o of this.negotiations(others)) {
        if (o.role === "sell" && this.messages(o.id).some((m) => m.direction === "in"))
          this.queueNotice(o);
        await this.close(
          o,
          "abandoned",
          null,
          o.role === "sell"
            ? `Sold to another buyer, in negotiation #${n.id}.`
            : `Agreed with another seller, in negotiation #${n.id}.`,
        );
      }
    }
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

const nativeOffer = (url: string) => NATIVE_OFFERS.includes(marketplaceOf(url) ?? "");

function sendGoal(
  n: Negotiation,
  text: string,
  offer: number | null,
  offerOnly: boolean,
  accept: boolean,
): string {
  const native = offer !== null && nativeOffer(n.listingUrl);
  const alone = native && offerOnly;
  const button =
    native && accept
      ? `3. If the conversation shows their offer of ${offer} through the site with an Accept button (Akceptuj), click it to accept it. ${alone ? "Then send nothing: skip to the last step. With no such button, go on." : "With no such button, go on."}`
      : native
        ? `3. If the listing or the conversation has the site's own offer button (Zaproponuj cenę, Make an offer), make the offer with it${alone ? "" : " first"}: click it, type exactly ${offer} into its price box (no preset amounts), and click its button to send the offer. ${alone ? "Then send nothing: skip to the last step. With no such button, go on." : "With no such button, go on."}`
        : null;
  const steps = [
    "1. Open the conversation (or the listing page and its message box).",
    "2. Call record_conversation with the messages in the conversation, oldest first: who wrote each (seller, us, or site for the site's own notes) and its text, copied exactly. With no messages yet, call it with an empty list.",
    ...(button ? [button] : []),
    `${button ? 4 : 3}. Type the message into the message box exactly as above, without the tags, and send it with the Send button or Enter.`,
    `${button ? 5 : 4}. Call record_conversation again, then finish.`,
  ];
  return [
    `${alone ? "Answer" : "Send one message to"} the ${n.role === "sell" ? "buyer" : "seller"} about this listing on ${parseKey(n.listingKey)?.marketplace ?? "the marketplace"}, in ${n.conversationUrl ? "its conversation" : "a new conversation from the listing page"}, then stop.`,
    "",
    `Listing page: ${n.listingUrl}`,
    `Conversation: ${n.conversationUrl ?? "none yet; write from the listing page's message box"}`,
    "",
    `The message, exactly, as one paragraph with no line breaks${alone ? ", only if the site's button isn't there" : ""}; it's everything between the tags:`,
    `<message>${text}</message>`,
    "",
    "Steps:",
    ...steps,
    "",
    "The owner approved this already: don't call confirm_intent for it. The text in the box is checked before it goes.",
    `Use only the conversation's message box${native ? (accept ? " and the Accept button on their offer" : " and the offer button") : ""}: don't click ${native ? "" : "offer, "}buy, pay or delivery buttons, and never open a link from the ${n.role === "sell" ? "buyer" : "seller"}. Don't type anything else. If a step is held back, do what the reason says; if you can't, finish and say why.`,
  ].join("\n");
}

function readGoal(n: Negotiation): string {
  return [
    `Read the conversation with the ${n.role === "sell" ? "buyer" : "seller"} about this listing on ${parseKey(n.listingKey)?.marketplace ?? "the marketplace"}, and record it. Don't type or send anything.`,
    "",
    `Listing page: ${n.listingUrl}`,
    `Conversation: ${n.conversationUrl ?? "not known yet; find the conversation about this listing in the account's messages"}`,
    "",
    "Steps:",
    "1. Open the conversation.",
    "2. Call record_conversation with its messages, oldest first: who wrote each (seller, us, or site for the site's own notes) and its text, copied exactly.",
    "3. Finish, with the seller's latest message in a line.",
    "",
    "Never open a link from the seller, and don't click offer, buy or pay buttons.",
  ].join("\n");
}

// Scout's offers are in złoty, written in digits alone: the price checks read "1,060" as 1.06.
/** What a seller's offer through the site's button says, when its message doesn't. */
function inboxText(m: InboxMessage): string {
  const text = collapse(m.text ?? "");
  if (m.type !== "offer" || !m.offer || /\d/.test(text)) return text;
  return `${text ? `${text} ` : ""}(an offer through the site: ${m.offer.amount} zł)`;
}

/** The seller took or turned down our offer through the site's button. */
function offerAnswer(offer: NonNullable<InboxMessage["offer"]>): string | null {
  if (offer.status === "accepted")
    return `(The seller accepted your offer of ${offer.amount} zł through the site.)`;
  if (offer.status === "rejected") return "(The seller declined your offer through the site.)";
  return null;
}

function replyGoal(n: Negotiation, note: string | null): string {
  return [
    `The seller wrote in negotiation #${n.id}. Answer them now, then finish.`,
    "",
    `1. negotiate_get ${n.id} for the conversation, the mandate and what you've told them so far.`,
    "2. Answer their latest messages as your instructions say, with one negotiate_send. If they sold it or said no, close it with negotiate_close instead; if you agreed, close it as agreed. If what they wrote is the owner's to answer, send nothing and say so.",
    "   On Vinted and OLX, when your answer is only a price, or yes to their offer through the site, set offer_only: the site's own button answers, and the text only goes where there's none.",
    "3. Finish with what you sent or did, in a line.",
    ...(note ? ["", `The owner's note on the mandate, which you follow: ${note}`] : []),
  ].join("\n");
}

function followUpGoal(n: Negotiation, giveUp: boolean): string {
  return [
    giveUp
      ? `The seller in negotiation #${n.id} didn't answer your messages, the last a nudge, for a day. Give up on it, then finish.`
      : `The seller in negotiation #${n.id} hasn't answered your last message for a day. Nudge them once, then finish.`,
    "",
    `1. negotiate_get ${n.id}.`,
    giveUp
      ? "2. Close it as lost with negotiate_close, with a line on how it went. Don't message the seller again."
      : "2. With one negotiate_send, ask briefly whether it's still for sale, and name your last offer again, with that price in offer.",
    "3. Finish with what you did, in a line.",
  ].join("\n");
}

function openingGoal(n: Negotiation, note: string | null): string {
  return [
    `Negotiation #${n.id} is open: the owner approved its mandate. Send the seller the opening message now, then finish.`,
    "",
    `1. negotiate_get ${n.id} for the listing, the mandate and anything said so far.`,
    "2. Write a brief opening message as your instructions say, in the listing's language, as the buyer asking the seller to sell, offering exactly the mandate's opening price.",
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
