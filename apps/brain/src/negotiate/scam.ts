// A seller's message that looks like the start of a scam (PLAN.md §16.1): paying off the platform, a
// link, or a move to another app or to contact details the mandate doesn't allow. The negotiation is
// held for the owner; the template's rule alone isn't enough.
import type { MandateContact } from "@hatbot/shared";
import { MARKETPLACE_HOSTS } from "./marketplace";
import { contactsIn, linksIn, plain } from "./policy";

/** Paying off the platform, and the apps scams move to. */
const OFF_PLATFORM =
  /(?<!\p{L})(blik\p{L}*|przelew\p{L}*|przelać|przelej\p{L}*|iban|numer\p{L}* konta|nr\.? konta|konto bankowe|revolut\p{L}*|paypal\p{L}*|western union|link\p{L}* do (?:płatności|zapłaty|odbioru|paczki|przesyłki)|payment link|bank transfer|whats\s?app\p{L}*|telegram\p{L}*|wa\.me|t\.me)(?!\p{L})/iu;

/** Cyrillic and Greek letters that look like Latin ones, lowercased. */
const LOOK_ALIKE: Record<string, string> = {
  а: "a",
  в: "b",
  е: "e",
  ё: "e",
  к: "k",
  м: "m",
  н: "h",
  о: "o",
  р: "p",
  с: "c",
  т: "t",
  у: "y",
  х: "x",
  ѕ: "s",
  ј: "j",
  ԁ: "d",
  α: "a",
  β: "b",
  ε: "e",
  κ: "k",
  ν: "v",
  ο: "o",
  ρ: "p",
  τ: "t",
  υ: "u",
  χ: "x",
};

/**
 * Text as a filter-dodger's spelling folds to: accents dropped, look-alike letters made Latin, i, l, 1
 * and | read as one letter ("BLIK", "BL1K", "BLlK"), 0 as o, and single letters split by spaces, dots
 * or dashes joined ("B L I K", "B-L-I-K").
 */
const fold = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/ł/g, "l")
    .replace(/[Ѐ-ӿͰ-Ͽ]/gu, (c) => LOOK_ALIKE[c] ?? c)
    .replace(/[il1|ıіӏι]/gu, "l")
    .replace(/0/g, "o")
    .replace(
      /(?<![\p{L}\p{N}])(?:[\p{L}\p{N}][\s.\-_*·]+){2,}[\p{L}\p{N}](?![\p{L}\p{N}])/gu,
      (m) => m.replace(/[^\p{L}\p{N}]/gu, ""),
    )
    .replace(/\s+/g, " ");

/**
 * Paying off the platform, card details, the apps scams move to and crypto, matched on folded text so
 * the disguised spellings count too. `*` is any ending.
 */
const DISGUISED = [
  "blik*",
  "przelew*",
  "przelac",
  "przelej*",
  "iban",
  "numer* konta",
  "nr konta",
  "nr. konta",
  "konto bankowe",
  "numer* rachunku",
  "nr rachunku",
  "rachunek bankowy",
  "rachunku bankowego",
  "revolut*",
  "rewolut*",
  "paypal*",
  "pejpal*",
  "pay pal",
  "western union",
  "dane karty",
  "danych karty",
  "dane do karty",
  "numer* karty",
  "nr karty",
  "cvv*",
  "cvc*",
  "kod* z karty",
  "kod* z aplikacji",
  "kod* do platnosci",
  "kod* platnosci",
  "kod* potwierdzenia",
  "kod* do potwierdzenia",
  "card number",
  "card details",
  "whatsapp*",
  "whatsap*",
  "whatsup*",
  "watsap*",
  "wsp",
  "telegram*",
  "wa.me",
  "t.me",
  "usdt",
  "bitcoin*",
  "btc",
  "krypto*",
  "crypto*",
  "tether",
  "ethereum",
];
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const DISGUISED_RE = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:${DISGUISED.map(
    (t) =>
      `(${t
        .split("*")
        .map((p) => escapeRe(fold(p)))
        .join("\\p{L}*")})`,
  ).join("|")})(?![\\p{L}\\p{N}])`,
  "u",
);

/** The word a disguised spelling stands for, or null. */
function disguised(text: string): string | null {
  const m = DISGUISED_RE.exec(fold(text));
  if (!m) return null;
  const i = m.slice(1).findIndex((g) => g !== undefined);
  return DISGUISED[i]?.replace(/\*/g, "") ?? m[0];
}

/**
 * A bank account number: a Polish one's 26 digits, with PL or without, or an IBAN with its country.
 * Not any long number: a parcel's is 24 digits.
 */
const ACCOUNT =
  /(?<![\p{L}\p{N}])(?:(?:PL ?)?\d{2}(?:[ -]?\d{4}){6}|[A-Z]{2}\d{2}(?: ?[A-Z\d]{4}){3,7}(?: ?[A-Z\d]{1,3})?)(?![\p{L}\p{N}])/u;
const digits = (s: string) => s.replace(/\D/g, "");

/** The marketplace's own name as a bare address ("OLX.pl"), which isn't a link anywhere. */
function ownSite(link: string): boolean {
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(link) ? link : `https://${link}`);
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    return MARKETPLACE_HOSTS.includes(host) && u.pathname === "/" && !u.search;
  } catch {
    return false;
  }
}

const CONTACTS: Record<MandateContact, string> = {
  phone: "a phone number",
  email: "an e-mail address",
  address: "an address",
  apps: "another app",
};

/** What in a seller's message looks like a scam, a phrase each; empty when nothing does. */
export function scamSignals(text: string, allow: MandateContact[]): string[] {
  const out: string[] = [];
  const off = OFF_PLATFORM.exec(text)?.[0] ?? disguised(text);
  if (off) out.push(`payment or talk off the platform (“${off}”)`);
  const account = ACCOUNT.exec(plain(text))?.[0];
  if (account) out.push(`a bank account number (“${account}”)`);
  const link = linksIn(text).find((l) => !ownSite(l));
  if (link) out.push(`a link (“${link}”)`);
  for (const c of contactsIn(text))
    if (
      !allow.includes(c.kind) &&
      !(c.kind === "apps" && off) &&
      !(c.kind === "phone" && account && digits(account).includes(digits(c.raw)))
    )
      out.push(`${CONTACTS[c.kind]} (“${c.raw}”)`);
  return out;
}
