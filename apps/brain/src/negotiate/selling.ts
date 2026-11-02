// Selling a flip Hatbot listed (N5): a buyer's conversation in Scout's inbox becomes a negotiation of
// its own, with a mandate the owner set by marking the flip ready: the asking price, down to Scout's
// break-even plus the margin in Settings.

import type { Mandate, Negotiation } from "@hatbot/shared";
import { collapse, namesListing } from "./gate";

export const SALE_DAYS = 30;
/** What the other buyers hear once one has it. Hatbot's words, not the model's. */
export const SOLD_NOTICE = "Dziękuję za zainteresowanie, ale przedmiot został już sprzedany.";

/** A listing Hatbot posted, as flip_listings keeps it. */
export type Posted = {
  id: number;
  flipId: number;
  channel: string;
  url: string;
  title: string;
  description: string;
  condition: string | null;
  delivery: { shipping: boolean; pickup: boolean };
  asking: number | null;
  currency: string;
};

export type BuyerConversation = {
  id: string;
  listingKey: string | null;
  role: string | null;
  title: string | null;
  url: string | null;
};

const titleKey = (s: string) =>
  collapse(s)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");

/**
 * The listing a buyer wrote about: by its id in the listing's address, else by its title, when only
 * one of ours on that marketplace has it. The title is ours, as posted.
 */
export function postedFor(c: BuyerConversation, posted: Posted[]): Posted | null {
  if (c.role !== "sell") return null;
  const id = c.listingKey?.slice(c.listingKey.indexOf(":") + 1) ?? "";
  const byId = posted.filter((p) => id && namesListing(p.url, p.url, id));
  if (byId.length === 1) return byId[0] ?? null;
  const t = titleKey(c.title ?? "");
  const byTitle = t ? posted.filter((p) => titleKey(p.title) === t) : [];
  return byTitle.length === 1 ? (byTitle[0] ?? null) : null;
}

/** The floor never goes above the asking price: then it holds at the price. */
export function saleMandate(
  p: Posted,
  asking: number,
  breakEven: number | null,
  marginPct: number,
  now: number,
): Mandate {
  const floor =
    breakEven === null ? asking : Math.min(asking, Math.ceil(breakEven * (1 + marginPct / 100)));
  return {
    currency: p.currency,
    opening: asking,
    target: asking,
    limit: floor,
    delivery: saleDelivery(p.delivery),
    expiresAt: new Date(now + SALE_DAYS * 86_400_000).toISOString(),
    allow: [],
  };
}

function saleDelivery(d: Posted["delivery"]): string {
  const ways = [
    d.shipping ? "shipping through the marketplace, which the buyer pays for on the site" : null,
    d.pickup ? "pickup in person" : null,
  ].filter(Boolean);
  return ways.length ? ways.join(", or ") : "as the listing says";
}

export function listingText(p: Posted): string {
  return [
    `Your listing, as posted: ${p.title}`,
    ...(p.condition ? [`Condition: ${p.condition}`] : []),
    p.description,
  ].join("\n");
}

export function saleGoal(n: Negotiation): string {
  return [
    `A buyer wrote about the owner's listing in negotiation #${n.id}: you're the seller. Answer them now, then finish.`,
    "",
    `1. negotiate_get ${n.id} for the listing as posted, the conversation and what you've told them so far.`,
    "2. Answer their latest messages with one negotiate_send, as the seller. Answer questions about the item only from the listing as posted; when it doesn't say, tell them you'll check and say so in your summary, for the owner. Hold the asking price; when they haggle, come down in small steps with a reason, and put your price in offer. When they agree to your price, or offer one you take, set agree with that price, then close the negotiation as agreed. If they lose interest, close it as lost.",
    "3. Finish with what you sent or did, in a line.",
    "",
    "The buyer pays on the site and the item goes through its delivery, or is picked up if the listing allows. Never give an address, phone number or account number, never take payment any other way, and never say it was sent: the owner sends it.",
  ].join("\n");
}
