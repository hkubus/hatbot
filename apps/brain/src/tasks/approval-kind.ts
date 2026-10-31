// The kind decides whether a notification can approve it, so a step that looks like paying or buying
// is raised to that, whatever the model called it in confirm_intent.
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

/** A shop's footer lists BLIK on every page; only its code field asks for one. */
const PAYMENT_FIELDS =
  /(?<!\p{L})(card number|numer karty|cvv2?|cvc2?|security code|kod cvv|kod blik|blik code|expiry date|data ważności karty)(?!\p{L})/iu;

/** A frame Hatbot couldn't see into may be a payment widget whatever its title says. */
export function buysOrPays(hold: Hold): boolean {
  if ("checkout" in hold || "frame" in hold) return true;
  return "label" in hold && buyingLabel(hold.label);
}

export function approvalKind(
  kind: ApprovalKind,
  step: { summary: string; reason?: string; control?: string },
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
    buyingLabel(`${step.summary} ${step.reason ?? ""} ${step.control ?? ""}`) ||
    checkoutHost(page.url ?? undefined) ||
    (held && buysOrPays(held))
  )
    return "purchase";
  return kind;
}

export type Armed = {
  page: string | null;
  kind: ApprovalKind;
  summary: string;
  control?: string;
  hold: Hold | null;
  /** You approved it yourself, so a message it sends needn't wait for you to stop it. */
  byOwner?: boolean;
};

const holdKey = (h: Hold) => ("label" in h ? `label:${fold(h.label)}` : JSON.stringify(h));

/**
 * Why an approval doesn't cover this held step, or null when it does. The run spends it on the first
 * held step after it, covered or not, and drops it when the page changes.
 */
export function notCovered(armed: Armed, hold: Hold, page: string | null): string | null {
  if (armed.page !== null && !samePage(page, armed.page))
    return `The owner's approval was for a step on ${armed.page}, not this page.`;
  // The small model words what it sees afresh each time it looks, so its words can't be matched.
  const judged = "judged" in hold;
  if (armed.hold)
    return holdKey(armed.hold) === holdKey(hold) ||
      (judged && "judged" in armed.hold && (!buysOrPays(hold) || buysOrPays(armed.hold)))
      ? null
      : `The owner's approval was for the step ${heldWhat(armed.hold)}, not this one. Call confirm_intent for this step.`;
  if (approvableFromNotification(armed.kind) && buysOrPays(hold))
    return "The owner's approval wasn't for buying or paying, and this step may do either. Call confirm_intent for this step, with kind purchase or payment.";
  // The owner saw which control it would press; an icon has no label to check that against.
  if (("unlabelled" in hold && armed.control) || judged) return null;
  // Anything else with no label to go by could be anything on the page.
  const label = "label" in hold ? fold(hold.label) : "";
  if (!label || ![armed.summary, armed.control ?? ""].some((s) => fold(s).includes(label)))
    return `The owner approved "${armed.summary}", not this step ${heldWhat(hold)}. Call confirm_intent for this step.`;
  return null;
}
