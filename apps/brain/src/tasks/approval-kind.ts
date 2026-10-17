// The kind of a desktop task's approval (PLAN.md §6.2). The model picks it in confirm_intent, and the
// kind decides whether a notification can approve it; so a step that looks like paying or buying is
// raised to that, whatever the model called it.
import type { ApprovalKind } from "@hatbot/shared";

/** Payment providers' pages: a step on one pays. */
const PAYMENT_HOSTS = [
  "payu.com",
  "payu.pl",
  "przelewy24.pl",
  "paypal.com",
  "stripe.com",
  "tpay.com",
  "paynow.pl",
  "dotpay.pl",
  "blik.com",
  "imoje.pl",
  "autopay.pl",
  "bluemedia.pl",
  "adyen.com",
  "klarna.com",
  "checkout.com",
  "braintreegateway.com",
  "pay.google.com",
];

/** Card and BLIK fields, as their labels read on a page. */
const PAYMENT_FIELDS =
  /(?<!\p{L})(card number|numer karty|cvv2?|cvc2?|security code|kod cvv|kod blik|blik code|blik|expiry date|data ważności karty)(?!\p{L})/iu;

/** Buying or paying, in what the model says it's about to do. */
const PURCHASE_WORDS =
  /(?<!\p{L})(buy|buying|purchase|purchasing|checkout|check out|pay|paying|payment|place (?:the |an |my )?order|order now|kup\p{L}*|zamów\p{L}*|zamawia\p{L}*|zapła\p{L}*|opłac\p{L}*|opłać|płać|płac\p{L}*)(?!\p{L})/iu;

const hostOf = (url: string | null) => {
  try {
    return url ? new URL(url).hostname.toLowerCase() : null;
  } catch {
    return null;
  }
};

/** The kind to ask with: the model's, or payment or purchase when the step or the screen says so. */
export function approvalKind(
  kind: ApprovalKind,
  step: { summary: string; reason?: string },
  page: { url: string | null; text: string | null },
): ApprovalKind {
  if (kind === "payment" || kind === "account_security") return kind;
  const host = hostOf(page.url);
  if (host && PAYMENT_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) return "payment";
  if (page.text && PAYMENT_FIELDS.test(page.text)) return "payment";
  if (kind === "purchase" || PURCHASE_WORDS.test(`${step.summary} ${step.reason ?? ""}`))
    return "purchase";
  return kind;
}
