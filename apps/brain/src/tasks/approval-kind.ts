// The kind of a desktop task's approval (PLAN.md §6.2). The model picks it in confirm_intent, and the
// kind decides whether a notification can approve it; so a step that looks like paying or buying is
// raised to that, whatever the model called it. An approval then covers only the step it was for.
import type { ApprovalKind } from "@hatbot/shared";
import { approvableFromNotification } from "../approvals";
import {
  buyingLabel,
  checkoutHost,
  fold,
  type Hold,
  heldWhat,
  paymentHost,
  samePage,
} from "./policy";

/** Card and BLIK fields, as their labels read on a page. */
const PAYMENT_FIELDS =
  /(?<!\p{L})(card number|numer karty|cvv2?|cvc2?|security code|kod cvv|kod blik|blik code|blik|expiry date|data ważności karty)(?!\p{L})/iu;

/** Buying or paying, in what the model says it's about to do: English, Polish and Czech. */
const PURCHASE_WORDS =
  /(?<!\p{L})(buy|buying|purchase|purchasing|checkout|check out|pay|paying|payment|place (?:the |an |my )?order|order(?: it)? now|deposit|kup\p{L}*|zamów\p{L}*|zamawia\p{L}*|zapła\p{L}*|opłac\p{L}*|opłać|płać|płac\p{L}*|zaliczk\p{L}*|zadatek|koupit|zaplat\p{L}*|objedn(?:at|ej|ejte|[aá]v[aá]m|[aá]vk[au])|dokon[cč]it (?:n[aá]kup|objedn[aá]vk\p{L}*))(?!\p{L})/iu;

const hostOf = (url: string | null) => {
  try {
    return url ? new URL(url).hostname.toLowerCase() : null;
  } catch {
    return null;
  }
};

/**
 * A held step that may buy or pay: at checkout, a buy, pay or order label, or in a frame Hatbot couldn't
 * see into, which may be a payment widget whatever its title says.
 */
export function buysOrPays(hold: Hold): boolean {
  if ("checkout" in hold || "frame" in hold) return true;
  return "label" in hold && buyingLabel(hold.label);
}

/**
 * The kind to ask with: the model's, or payment or purchase when the step or the screen says so. `held`:
 * the step on this page that was held for this approval, if one was.
 */
export function approvalKind(
  kind: ApprovalKind,
  step: { summary: string; reason?: string },
  page: { url: string | null; text: string | null },
  held: Hold | null = null,
): ApprovalKind {
  if (kind === "payment" || kind === "account_security") return kind;
  const host = hostOf(page.url);
  if (host && paymentHost(host)) return "payment";
  if (page.text && PAYMENT_FIELDS.test(page.text)) return "payment";
  if (held && "checkout" in held && paymentHost(held.checkout)) return "payment";
  if (
    kind === "purchase" ||
    PURCHASE_WORDS.test(`${step.summary} ${step.reason ?? ""}`) ||
    checkoutHost(page.url ?? undefined) ||
    (held && buysOrPays(held))
  )
    return "purchase";
  return kind;
}

/** An approved confirm_intent: the page it was asked on, its kind, and the held step it was for. */
export type Armed = { page: string | null; kind: ApprovalKind; hold: Hold | null };

const holdKey = (h: Hold) => ("label" in h ? `label:${fold(h.label)}` : JSON.stringify(h));

/**
 * Why an approval doesn't cover this held step, or null when it does. One asked for a held step covers
 * that step again; one asked before trying covers the next held step on its page, unless that may buy or
 * pay and the approval was of a kind a notification can give.
 */
export function notCovered(armed: Armed, hold: Hold, page: string | null): string | null {
  if (armed.page !== null && !samePage(page, armed.page))
    return `The owner's approval was for a step on ${armed.page}, not this page.`;
  if (armed.hold && holdKey(armed.hold) !== holdKey(hold))
    return `The owner's approval was for the step ${heldWhat(armed.hold)}, not this one. Call confirm_intent for this step.`;
  if (!armed.hold && approvableFromNotification(armed.kind) && buysOrPays(hold))
    return "The owner's approval wasn't for buying or paying, and this step may do either. Call confirm_intent for this step, with kind purchase or payment.";
  return null;
}
