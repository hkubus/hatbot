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
  hostOf,
  paymentHost,
  samePage,
} from "./policy";

/**
 * Card and BLIK fields, as their labels read on a page. BLIK alone is a way to pay that a shop's footer
 * lists on every page; only its code field asks for one.
 */
const PAYMENT_FIELDS =
  /(?<!\p{L})(card number|numer karty|cvv2?|cvc2?|security code|kod cvv|kod blik|blik code|expiry date|data ważności karty)(?!\p{L})/iu;

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
    buyingLabel(`${step.summary} ${step.reason ?? ""}`) ||
    checkoutHost(page.url ?? undefined) ||
    (held && buysOrPays(held))
  )
    return "purchase";
  return kind;
}

/**
 * An approved confirm_intent: the page it was asked on, its kind, what it said it would do, and the held
 * step it was for.
 */
export type Armed = { page: string | null; kind: ApprovalKind; summary: string; hold: Hold | null };

const holdKey = (h: Hold) => ("label" in h ? `label:${fold(h.label)}` : JSON.stringify(h));

/**
 * Why an approval doesn't cover this held step, or null when it does, on its page only. One asked for a
 * held step covers that step. One asked before trying covers a step whose label it names, and not one
 * that may buy or pay if a notification could give it; the run spends it on the first held step after
 * it, covered or not, and drops it when the page changes.
 */
export function notCovered(armed: Armed, hold: Hold, page: string | null): string | null {
  if (armed.page !== null && !samePage(page, armed.page))
    return `The owner's approval was for a step on ${armed.page}, not this page.`;
  if (armed.hold)
    return holdKey(armed.hold) === holdKey(hold)
      ? null
      : `The owner's approval was for the step ${heldWhat(armed.hold)}, not this one. Call confirm_intent for this step.`;
  if (approvableFromNotification(armed.kind) && buysOrPays(hold))
    return "The owner's approval wasn't for buying or paying, and this step may do either. Call confirm_intent for this step, with kind purchase or payment.";
  // A step with no label to go by could be anything on the page.
  const label = "label" in hold ? fold(hold.label) : "";
  if (!label || !fold(armed.summary).includes(label))
    return `The owner approved "${armed.summary}", not this step ${heldWhat(hold)}. Call confirm_intent for this step.`;
  return null;
}
