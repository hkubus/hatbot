import type { Negotiation, NegotiationStatus } from "@hatbot/shared";
import { time } from "./format";

const STATUS: Record<NegotiationStatus, [string, string]> = {
  awaiting_mandate: ["attn", "Needs approval"],
  open: ["brand", "Open"],
  agreed: ["ok", "Agreed"],
  lost: ["", "Lost"],
  abandoned: ["", "Abandoned"],
  expired: ["", "Expired"],
  paid: ["ok", "Paid"],
  received: ["ok", "Received"],
};

export function NegotiationChip({ status }: { status: NegotiationStatus }) {
  const [cls, label] = STATUS[status];
  return <span className={cls === "attn" ? "chip attn" : `status ${cls}`}>{label}</span>;
}

export const money = (n: number, currency = "PLN") =>
  `${n.toLocaleString("en-GB", { maximumFractionDigits: 2 })} ${currency === "PLN" ? "zł" : currency}`;

const quote = (text: string) => `“${text.length > 200 ? `${text.slice(0, 199)}…` : text}”`;

/** A seller's words are shown as text, never as markdown. */
export function negotiationText(n: Negotiation): string {
  const c = n.mandate.currency;
  const last = n.lastMessage;
  switch (n.status) {
    case "awaiting_mandate":
      return "Waiting for your approval.";
    case "open":
      if (!last) {
        const at = n.nextFollowUpAt;
        return at && Date.parse(at) > Date.now()
          ? `Writes to the seller at ${time(at)}.`
          : "Writing to the seller.";
      }
      if (last.direction === "in") return `The seller wrote ${quote(last.text)}`;
      if (last.direction === "owner") return `You wrote ${quote(last.text)}`;
      if (last.status === "sending") return `Sending ${quote(last.text)}`;
      if (last.status === "unconfirmed") return `Sent, but not confirmed: ${quote(last.text)}`;
      return `Sent ${quote(last.text)}`;
    case "agreed":
      return n.agreedPrice !== null ? `Agreed at ${money(n.agreedPrice, c)}.` : "Agreed.";
    case "lost":
      return "The seller sold it or said no.";
    case "abandoned":
      return "Abandoned.";
    case "expired":
      return n.closedAt && Date.parse(n.mandate.expiresAt) <= Date.parse(n.closedAt)
        ? "The mandate ran out."
        : "The mandate wasn't approved in time.";
    case "paid":
      return n.agreedPrice !== null ? `Paid ${money(n.agreedPrice, c)}.` : "Paid.";
    case "received":
      return "Received.";
  }
}
