// The sellers' replies, read through Scout's marketplace sessions without the model or the desktop:
// every 10 minutes while a negotiation waits on a seller, and a new message wakes the bot to answer.

import { createHash } from "node:crypto";
import type { Bot, Negotiation } from "@hatbot/shared";
import type { Chats } from "../agent/chats";
import type { Bots } from "../bots";
import type { Db } from "../db";
import type { Plugins } from "../plugins/registry";
import type { Tasks } from "../tasks/service";
import { parseKey, readScout, scoutTool } from "./appraise";
import type { InboxMessage, Negotiations } from "./service";

export const INBOX_EVERY_MS = 10 * 60_000;

export type SellerInboxDeps = {
  db: Db;
  negotiations: Negotiations;
  plugins: Plugins;
  bots: Bots;
  chats: Chats;
  tasks: Tasks;
};

type Listed = { id: string; listingKey: string | null; role: string | null; seen: string };

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const str = (v: unknown) => (typeof v === "string" ? v : "");

function listed(out: Record<string, unknown>): Listed[] {
  return (Array.isArray(out.conversations) ? out.conversations : []).flatMap((c) => {
    const o = obj(c);
    const last = obj(o.lastMessage);
    if (!str(o.id)) return [];
    const seen = createHash("sha256")
      .update(JSON.stringify([o.updatedAt ?? null, last.id ?? null, last.text ?? null]))
      .digest("hex");
    return [
      { id: str(o.id), listingKey: str(o.listingKey) || null, role: str(o.role) || null, seen },
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
  /** Inboxes that failed, already said in the chat, until one reads again. */
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
    for (const [k, ns] of groups) {
      const [botId = "", market = ""] = k.split("\n");
      const bot = this.d.bots.get(botId);
      if (!bot) continue;
      try {
        await this.read(bot, market, ns);
        this.told.delete(k);
      } catch (err) {
        console.error(`seller inbox ${market} failed`, err);
        if (this.told.has(k)) continue;
        this.told.add(k);
        this.d.chats.note(
          bot.id,
          `Scout couldn't read the ${market} inbox, so sellers' replies there aren't read until it can: ${err instanceof Error ? err.message : String(err)}`,
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
        conversations.find((x) => x.listingKey === n.listingKey && x.role !== "sell");
      if (!c || (c.id === state?.conversation && c.seen === state.seen)) continue;
      const read = await readScout(conversation, { id: c.id }, signal);
      this.d.negotiations.recordInbox(n.id, messagesOf(read));
      this.d.db
        .query("UPDATE negotiations SET inbox_conversation = ?, inbox_seen = ? WHERE id = ?")
        .run(c.id, c.seen, n.id);
    }
  }
}
