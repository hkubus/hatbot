// The mandate (PLAN.md §16.1): what Hatbot may do on its own in one negotiation, as the owner approves
// it. Its approval card, its checks, and a steering note on the card turned into new numbers by Haiku,
// which reads only the note, the mandate and the asking price: nothing a seller wrote.
import type Anthropic from "@anthropic-ai/sdk";
import { MANDATE_CONTACTS, type Mandate, type Negotiation } from "@hatbot/shared";
import { z } from "zod";
import type { ModelClient } from "../agent/model";
import type { Spend } from "../spend";

/** The mandate as negotiate_start takes it, and as Haiku gives it back from a note. */
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

const zl = (n: number, currency = "PLN") =>
  `${n.toLocaleString("en-GB", { maximumFractionDigits: 2 })} ${currency === "PLN" ? "zł" : currency}`;

/** Why these numbers aren't a mandate, or null when they are. */
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

/** Builds a mandate from the tool's input, expiring `expires_in_days` from now. */
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

/** The mandate's numbers in a line: "open at 1,060 zł, aim for 1,250 zł, pay at most 1,400 zł". */
export function mandateTerms(n: Pick<Negotiation, "mandate" | "role">): string {
  const m = n.mandate;
  return `open at ${zl(m.opening, m.currency)}, aim for ${zl(m.target, m.currency)}, ${n.role === "buy" ? "pay at most" : "take at least"} ${zl(m.limit, m.currency)}`;
}

/** The mandate approval's one line. The listing's title is the seller's words, so it's quoted. */
export function mandateSummary(n: Negotiation): string {
  const title = n.title.length > 60 ? `${n.title.slice(0, 59)}…` : n.title;
  return `Negotiate for “${title}”: ${mandateTerms(n)}`;
}

/** "23 Oct", as the web shows dates. */
const day = (iso: string) =>
  new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });

const contacts = (allow: string[]) => (allow.length ? allow.join(", ") : "none");

/** The mandate approval's detail: the appraisal it rests on and the rest of the mandate. */
export function mandateReason(n: Negotiation, botName: string): string {
  const m = n.mandate;
  const a = n.appraisal;
  return [
    n.listingUrl,
    `Asking ${n.asking !== null ? zl(n.asking, m.currency) : "unknown"}.`,
    a
      ? `Scout: open at ${zl(a.opening, a.currency)}, aim for ${zl(a.target, a.currency)}, walk away ${n.role === "buy" ? "above" : "below"} ${zl(a.walkAway, a.currency)}. ${a.basis}`
      : "No appraisal from Scout.",
    `Delivery: ${m.delivery}. Until ${day(m.expiresAt)}. Contact details: ${contacts(m.allow)}.`,
    `Inside this, ${botName} sends and agrees on its own; outside it, it asks you. A note can change the numbers.`,
  ].join("\n");
}

/**
 * What a mandate made from a note allows beyond the one approved, a line each with the old value and
 * the new: a higher ceiling (or lower floor), other delivery terms, more contact details.
 */
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
  return out;
}

const NOTE_MODEL = "claude-haiku-5-5";

const SET_MANDATE: Anthropic.Beta.BetaTool = {
  name: "set_mandate",
  description: "The mandate with the owner's note applied.",
  input_schema: z.toJSONSchema(MandateInput) as Anthropic.Beta.BetaTool.InputSchema,
};

const NOTE_PROMPT = `You apply the owner's note to the mandate of a negotiation on a second-hand marketplace. The mandate says what a bot may do on its own while haggling for one listing: the opening offer, the target, the limit (buying: the most to pay; selling: the least to take), delivery terms, how many days it lasts, and which contact details its messages may carry.

Change only what the note asks to change, and keep everything else exactly as it is. A note that doesn't touch the mandate, such as advice on tone, leaves it as it is. Keep the numbers in order: buying, opening ≤ target ≤ limit; selling, opening ≥ target ≥ limit. If the note sets only the limit, move the target or the opening only as far as that order needs. Amounts are plain numbers in the mandate's currency. Call set_mandate.`;

/**
 * The mandate with the owner's note applied, by Haiku with a forced tool call; or why it couldn't be:
 * the note is then shown to the owner again with the old numbers.
 */
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
    d.spend.check(0.02);
    const res = await d.model.create({
      model: NOTE_MODEL,
      max_tokens: 1000,
      system: NOTE_PROMPT,
      tools: [SET_MANDATE],
      tool_choice: { type: "tool", name: SET_MANDATE.name },
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
    });
    d.spend.recordResponse({
      model: NOTE_MODEL,
      purpose: "negotiation",
      usage: res.usage,
      botId: n.botId,
    });
    const call = res.content.find(
      (b): b is Anthropic.Beta.BetaToolUseBlock =>
        b.type === "tool_use" && b.name === SET_MANDATE.name,
    );
    const parsed = MandateInput.safeParse(call?.input);
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
