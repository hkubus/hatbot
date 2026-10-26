// A steering note on the mandate's card is turned into new numbers by Haiku, which reads only the note,
// the mandate and the asking price: nothing a seller wrote.
import { transformJSONSchema } from "@anthropic-ai/sdk/lib/transform-json-schema";
import { MANDATE_CONTACTS, type Mandate, type Negotiation } from "@hatbot/shared";
import { z } from "zod";
import { type ModelClient, oneShot } from "../agent/model";
import type { Spend } from "../spend";
import { allowance, zl } from "./policy";

export const MandateInput = z.object({
  opening: z.number().positive().describe("The first offer"),
  target: z.number().positive().describe("What to aim for"),
  limit: z
    .number()
    .positive()
    .describe("Buying: the most to pay (the ceiling). Selling: the least to take (the floor)"),
  delivery: z
    .string()
    .trim()
    .min(1)
    .max(300)
    .describe('Delivery terms, e.g. "OLX delivery with buyer protection"'),
  expires_in_days: z.number().int().min(1).max(30).default(7),
  allow: z
    .array(z.enum(MANDATE_CONTACTS))
    .default([])
    .describe("Contact details messages may carry; none unless the owner said so"),
});
export type MandateInput = z.infer<typeof MandateInput>;

/** negotiate_start's mandate: the model never sets the limit, or reads it back. */
export const StartInput = MandateInput.omit({ limit: true }).extend({
  owner_max: z
    .number()
    .positive()
    .optional()
    .describe(
      "The most to pay, in the listing's currency, only if the owner named it in their own words; leave it out otherwise",
    ),
});
export type StartInput = z.infer<typeof StartInput>;

/**
 * The limit for a purchase: the owner's own max, else Scout's walk-away price, else the asking price.
 * Its errors never name a limit the model wasn't given.
 */
export function startLimit(
  i: StartInput,
  walkAway: number | null,
  asking: number | null,
  currency: string,
): { limit: number } | { problem: string } {
  if (i.opening > i.target) return { problem: "The opening offer must be at most the target." };
  if (asking !== null && i.target > asking)
    return {
      problem: `The target is above the asking price (${zl(asking, currency)}): there's no paying more than asked.`,
    };
  if (i.owner_max !== undefined) {
    if (i.owner_max < i.target) return { problem: "The target is above the owner's max." };
    return { limit: asking !== null ? Math.min(i.owner_max, asking) : i.owner_max };
  }
  const limit = walkAway ?? asking;
  if (limit === null)
    return {
      problem:
        "Scout couldn't appraise this listing and it shows no price, so there's no limit to set. Ask the owner for the most to pay, and pass it as owner_max.",
    };
  if (i.target > limit)
    return {
      problem:
        "The target is above what Scout's appraisal says the listing is worth. Aim lower, or ask the owner for the most to pay and pass it as owner_max.",
    };
  return { limit };
}

export function mandateProblem(
  m: Pick<Mandate, "opening" | "target" | "limit">,
  role: "buy" | "sell",
  asking: number | null,
  currency: string,
): string | null {
  if (role === "buy") {
    if (!(m.opening <= m.target && m.target <= m.limit))
      return "The opening offer, target and limit must go up in that order: opening ≤ target ≤ limit.";
    if (asking !== null && m.limit > asking)
      return `The limit (${zl(m.limit, currency)}) is above the asking price (${zl(asking, currency)}): there's no paying more than asked.`;
  } else if (!(m.opening >= m.target && m.target >= m.limit))
    return "Selling, the opening price, target and floor must come down in that order: opening ≥ target ≥ floor.";
  return null;
}

export function toMandate(i: MandateInput, currency: string, now: number): Mandate {
  return {
    currency,
    opening: i.opening,
    target: i.target,
    limit: i.limit,
    delivery: i.delivery,
    expiresAt: new Date(now + i.expires_in_days * 86_400_000).toISOString(),
    allow: [...new Set(i.allow)],
  };
}

export function mandateTerms(n: Pick<Negotiation, "mandate" | "role">): string {
  const m = n.mandate;
  return `${mandateAims(n)}, ${n.role === "buy" ? "pay at most" : "take at least"} ${zl(m.limit, m.currency)}`;
}

/** The mandate as the model reads it: without the limit, which only the code checks. */
export function mandateAims(n: Pick<Negotiation, "mandate">): string {
  const m = n.mandate;
  return `open at ${zl(m.opening, m.currency)}, aim for ${zl(m.target, m.currency)}`;
}

/** The title is the seller's words: without quote marks or line breaks, so it can't close the quote and read as ours. */
export function quotedTitle(title: string): string {
  const t = title
    .replace(/["＂„‚\p{Pi}\p{Pf}]/gu, "")
    .replace(/[\p{Cc}\p{Zl}\p{Zp}\s]+/gu, " ")
    .trim();
  return `“${t.length > 60 ? `${t.slice(0, 59)}…` : t}”`;
}

/** The terms first, so a cut notification still shows them. */
export function mandateSummary(n: Negotiation): string {
  return `Negotiate: ${mandateTerms(n)} · ${quotedTitle(n.title)}`;
}

const day = (iso: string) =>
  new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });

const contacts = (allow: string[]) => (allow.length ? allow.join(", ") : "none");

export function mandateReason(n: Negotiation, botName: string): string {
  const m = n.mandate;
  const a = n.appraisal;
  const extra = n.role === "buy" ? allowance(m.delivery, m.limit) : 0;
  return [
    n.listingUrl,
    `Asking ${n.asking !== null ? zl(n.asking, m.currency) : "unknown"}.`,
    a
      ? `Scout: open at ${zl(a.opening, a.currency)}, aim for ${zl(a.target, a.currency)}, walk away ${n.role === "buy" ? "above" : "below"} ${zl(a.walkAway, a.currency)}. ${a.basis}`
      : "No appraisal from Scout.",
    `Delivery: ${m.delivery}.${extra ? ` Up to ${zl(extra, m.currency)} on top of the limit for shipping.` : ""} Until ${day(m.expiresAt)}. Contact details: ${contacts(m.allow)}.`,
    `Inside this, ${botName} sends and agrees on its own; outside it, it asks you. A note can change the numbers.`,
  ].join("\n");
}

/** What a mandate made from a note allows beyond the one approved. */
export function widened(n: Pick<Negotiation, "mandate" | "role">, after: Mandate): string[] {
  const b = n.mandate;
  const buying = n.role === "buy";
  const out: string[] = [];
  if (buying ? after.limit > b.limit : after.limit < b.limit)
    out.push(
      `${buying ? "Pay at most" : "Take at least"}: ${zl(b.limit, b.currency)} → ${zl(after.limit, after.currency)}`,
    );
  if (after.delivery !== b.delivery) out.push(`Delivery: ${b.delivery} → ${after.delivery}`);
  if (after.allow.some((c) => !b.allow.includes(c)))
    out.push(`Contact details: ${contacts(b.allow)} → ${contacts(after.allow)}`);
  if (Date.parse(after.expiresAt) > Date.parse(b.expiresAt))
    out.push(`Until: ${day(b.expiresAt)} → ${day(after.expiresAt)}`);
  return out;
}

const NOTE_MODEL = "claude-haiku-5-5";

export const NOTE_PROMPT = `You apply the owner's note to the mandate of a negotiation on a second-hand marketplace. The mandate says what a bot may do on its own while haggling for one listing: the opening offer, the target, the limit (buying: the most to pay; selling: the least to take), delivery terms, how many days it lasts, and which contact details its messages may carry.

Change only what the note asks to change, and keep everything else exactly as it is. A note that doesn't touch the mandate, such as advice on tone, leaves it as it is. Keep the numbers in order: buying, opening ≤ target ≤ limit; selling, opening ≥ target ≥ limit. If the note sets only the limit, move the target or the opening only as far as that order needs. Amounts are plain numbers in the mandate's currency. Answer with the whole mandate.`;

/** When the note can't be applied, it's shown to the owner again with the old numbers. */
export async function applyNote(
  d: { model: ModelClient; spend: Spend },
  n: Negotiation,
  note: string,
  now: number,
): Promise<{ mandate: Mandate } | { error: string }> {
  const m = n.mandate;
  const days = Math.max(1, Math.min(30, Math.round((Date.parse(m.expiresAt) - now) / 86_400_000)));
  const current: MandateInput = {
    opening: m.opening,
    target: m.target,
    limit: m.limit,
    delivery: m.delivery,
    expires_in_days: days,
    allow: m.allow,
  };
  try {
    const out = await oneShot(
      d,
      {
        model: NOTE_MODEL,
        max_tokens: 1000,
        output_config: {
          format: {
            type: "json_schema",
            schema: transformJSONSchema(z.toJSONSchema(MandateInput)),
          },
        },
        system: NOTE_PROMPT,
        messages: [
          {
            role: "user",
            content: [
              `<listing>\n${n.role === "buy" ? "Buying" : "Selling"}; asking ${n.asking ?? "unknown"} ${m.currency}\n</listing>`,
              `<mandate>\n${JSON.stringify(current)}\n</mandate>`,
              `<owner_note>\n${note}\n</owner_note>`,
            ].join("\n\n"),
          },
        ],
      },
      { purpose: "negotiation", botId: n.botId },
    );
    const parsed = MandateInput.safeParse(JSON.parse(out));
    if (!parsed.success) return { error: "Haiku's answer wasn't a mandate" };
    const problem = mandateProblem(parsed.data, n.role, n.asking, n.mandate.currency);
    if (problem) return { error: problem };
    const unchanged = parsed.data.expires_in_days === days;
    const mandate = toMandate(parsed.data, m.currency, now);
    return { mandate: unchanged ? { ...mandate, expiresAt: m.expiresAt } : mandate };
  } catch (err) {
    console.error("applying a mandate note failed", err);
    return { error: "Haiku couldn't be asked" };
  }
}
