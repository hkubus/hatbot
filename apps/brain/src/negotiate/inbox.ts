// The other side's messages, read through Scout's marketplace sessions without the model or the
// desktop: every 10 minutes while a negotiation waits on a seller, or a listing Hatbot posted is up,
// and a new message wakes the bot to answer. A buyer writing about one of those listings starts a
// negotiation of its own (N5).

import { createHash } from "node:crypto";
import type { PluginTool } from "@hatbot/plugin-sdk";
import type { Bot, Negotiation } from "@hatbot/shared";
import type { Chats } from "../agent/chats";
import type { Bots } from "../bots";
import type { Db } from "../db";
import type { Plugins } from "../plugins/registry";
import type { Tasks } from "../tasks/service";
import { parseKey, readScout, scoutTool } from "./appraise";
import { type BuyerConversation, type Flips, openFlips, postedFor } from "./selling";
import type { InboxMessage, Negotiations } from "./service";

export const INBOX_EVERY_MS = 10 * 60_000;
/** Most failures are a timeout that the next read gets past. */
export const INBOX_FAILING_MS = 30 * 60_000;

export type SellerInboxDeps = {
  db: Db;
  clock: () => number;
  negotiations: Negotiations;
  plugins: Plugins;
  bots: Bots;
  chats: Chats;
  tasks: Tasks;
};

type Listed = BuyerConversation & { seen: string };

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const str = (v: unknown) => (typeof v === "string" ? v : "");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);

function listed(out: Record<string, unknown>): Listed[] {
  return (Array.isArray(out.conversations) ? out.conversations : []).flatMap((c) => {
    const o = obj(c);
    const last = obj(o.lastMessage);
    if (!str(o.id)) return [];
    const seen = createHash("sha256")
      .update(JSON.stringify([o.updatedAt ?? null, last.id ?? null, last.text ?? null]))
      .digest("hex");
    return [
      {
        id: str(o.id),
        listingKey: str(o.listingKey) || null,
        role: str(o.role) || null,
        title: str(o.title) || null,
        url: str(o.url) || null,
        seen,
      },
    ];
  });
}

function messagesOf(out: Record<string, unknown>): InboxMessage[] {
  return (Array.isArray(out.messages) ? out.messages : []).flatMap((m) => {
    const o = obj(m);
    const offer = obj(o.offer);
    const direction = o.direction;
    if (!str(o.id) || (direction !== "in" && direction !== "out")) return [];
    return [
      {
        id: str(o.id),
        direction,
        type: str(o.type),
        text: str(o.text),
        offer:
          typeof offer.amount === "number" && offer.amount > 0
            ? { amount: offer.amount, status: str(offer.status) || null }
            : null,
      },
    ];
  });
}

export class SellerInbox {
  private ticking: Promise<void> | null = null;
  /** When each inbox started failing, until one reads again. */
  private failing = new Map<string, number>();
  /** Inboxes whose failing was said in the chat. */
  private told = new Set<string>();

  constructor(readonly d: SellerInboxDeps) {}

  tick(): Promise<void> {
    this.ticking ??= this.check().finally(() => {
      this.ticking = null;
    });
    return this.ticking;
  }

  private async check() {
    if (this.d.tasks.paused()) return;
    const groups = new Map<string, Negotiation[]>();
    for (const n of this.d.negotiations.watched()) {
      const market = parseKey(n.listingKey)?.marketplace;
      if (!market) continue;
      const k = `${n.botId}\n${market}`;
      groups.set(k, [...(groups.get(k) ?? []), n]);
    }
    // Where Hatbot's listings are up, buyers may write.
    const up = this.d.db
      .query<{ bot_id: string; channel: string }, []>(
        "SELECT DISTINCT bot_id, channel FROM flip_listings WHERE status = 'listed' AND url IS NOT NULL",
      )
      .all();
    for (const r of up) {
      const k = `${r.bot_id}\n${r.channel}`;
      if (!groups.has(k)) groups.set(k, []);
    }
    for (const [k, ns] of groups) {
      const [botId = "", market = ""] = k.split("\n");
      const bot = this.d.bots.get(botId);
      if (!bot) continue;
      try {
        await this.read(bot, market, ns);
        this.failing.delete(k);
        this.told.delete(k);
      } catch (err) {
        console.error(`seller inbox ${market} failed`, err);
        const now = this.d.clock();
        const since = this.failing.get(k) ?? now;
        this.failing.set(k, since);
        if (this.told.has(k) || now - since < INBOX_FAILING_MS) continue;
        this.told.add(k);
        this.d.chats.note(
          bot.id,
          `Scout hasn't been able to read the ${market} inbox for half an hour, so messages there aren't read until it can: ${err instanceof Error ? err.message : String(err)}`,
          "Scout's answer",
        );
      }
    }
  }

  private async read(bot: Bot, marketplace: string, ns: Negotiation[]) {
    const tools = this.d.plugins.brainTools(bot.plugins);
    const inbox = scoutTool(tools, "scout_inbox");
    const conversation = scoutTool(tools, "scout_conversation");
    if (!inbox || !conversation) return;
    const signal = AbortSignal.timeout(120_000);
    const conversations = listed(await readScout(inbox, { marketplace }, signal));
    for (const n of ns) {
      const state = this.d.db
        .query<{ conversation: string | null; seen: string | null }, [number]>(
          "SELECT inbox_conversation AS conversation, inbox_seen AS seen FROM negotiations WHERE id = ?",
        )
        .get(n.id);
      const c =
        conversations.find((x) => x.id === state?.conversation) ??
        (n.role === "buy"
          ? conversations.find((x) => x.listingKey === n.listingKey && x.role !== "sell")
          : undefined);
      if (!c || (c.id === state?.conversation && c.seen === state.seen)) continue;
      await this.record(n.id, c, conversation, signal);
    }
    const posted = this.d.negotiations.posted({ botId: bot.id, channel: marketplace });
    let flips: Flips | null | undefined;
    for (const c of conversations) {
      if (this.d.negotiations.forConversation(c.id) !== null) continue;
      const p = postedFor(c, posted);
      if (!p || this.d.negotiations.soldHere(p.flipId)) continue;
      flips ??= await openFlips(tools, signal);
      const flip = flips?.items.get(p.flipId);
      // Scout has it sold. Past the 50 it lists, it may only be older.
      if (flips?.all && !flip) continue;
      const asking = p.asking ?? num(obj(flip?.askingPrices)[marketplace]);
      if (asking === null) continue;
      const n = this.d.negotiations.openSale({
        bot,
        posted: p,
        asking,
        conversation: c,
        breakEven: num(obj(flip?.breakEven)[marketplace]),
      });
      await this.record(n.id, c, conversation, signal);
    }
  }

  private async record(id: number, c: Listed, conversation: PluginTool, signal: AbortSignal) {
    const read = await readScout(conversation, { id: c.id }, signal);
    this.d.negotiations.recordInbox(id, messagesOf(read));
    this.d.db
      .query("UPDATE negotiations SET inbox_conversation = ?, inbox_seen = ? WHERE id = ?")
      .run(c.id, c.seen, id);
  }
}
