// A seller's message that looks like the start of a scam (PLAN.md §16.1): paying off the platform, a
// link, or a move to another app or to contact details the mandate doesn't allow. The negotiation is
// held for the owner; the template's rule alone isn't enough.
import type { MandateContact } from "@hatbot/shared";
import { contactsIn, linksIn } from "./policy";

/** Paying off the platform, and the apps scams move to. */
const OFF_PLATFORM =
  /(?<!\p{L})(blik\p{L}*|przelew\p{L}*|przelać|przelej\p{L}*|iban|numer\p{L}* konta|nr\.? konta|konto bankowe|revolut\p{L}*|paypal\p{L}*|western union|link\p{L}* do (?:płatności|zapłaty|odbioru|paczki|przesyłki)|payment link|bank transfer|whats\s?app\p{L}*|telegram\p{L}*|wa\.me|t\.me)(?!\p{L})/iu;

const CONTACTS: Record<MandateContact, string> = {
  phone: "a phone number",
  email: "an e-mail address",
  address: "an address",
  apps: "another app",
};

/** What in a seller's message looks like a scam, a phrase each; empty when nothing does. */
export function scamSignals(text: string, allow: MandateContact[]): string[] {
  const out: string[] = [];
  const off = OFF_PLATFORM.exec(text)?.[0];
  if (off) out.push(`payment or talk off the platform (“${off}”)`);
  const link = linksIn(text)[0];
  if (link) out.push(`a link (“${link}”)`);
  for (const c of contactsIn(text))
    if (!allow.includes(c.kind) && !(c.kind === "apps" && off))
      out.push(`${CONTACTS[c.kind]} (“${c.raw}”)`);
  return out;
}
