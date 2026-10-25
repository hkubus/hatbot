// A seller's message that looks like the start of a scam holds the negotiation for the owner; the
// template's rule alone isn't enough.
import type { MandateContact } from "@hatbot/shared";
import { escapeRe } from "./gate";
import { MARKETPLACE_HOSTS } from "./marketplace";
import { CONTACT_NAMES, contactsIn, linksIn, plain } from "./policy";

const OFF_PLATFORM =
  /(?<!\p{L})(blik\p{L}*|przelew\p{L}*|przelać|przelej\p{L}*|iban|numer\p{L}* konta|nr\.? konta|konto bankowe|revolut\p{L}*|paypal\p{L}*|western union|link\p{L}* do (?:płatności|zapłaty|odbioru|paczki|przesyłki)|payment link|bank transfer|whats\s?app\p{L}*|telegram\p{L}*|wa\.me|t\.me)(?!\p{L})/iu;

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

/** So a filter-dodger's spelling counts too: "BL1K", "BLlK", "B L I K", Cyrillic look-alikes. */
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

/** `*` is any ending; `not` lists what may not follow ("kod z aplikacji" is a bank's, not InPost's). */
type Term = string | { t: string; not: string[] };
const stem = (t: string) =>
  t
    .split("*")
    .map((p) => escapeRe(fold(p)))
    .join("\\p{L}*");
/** One pattern for a list of terms, a group each, so the match says which term it was. */
const termsRe = (terms: Term[]) =>
  new RegExp(
    `(?<![\\p{L}\\p{N}])(?:${terms
      .map((t) =>
        typeof t === "string"
          ? `(${stem(t)})`
          : `(${stem(t.t)}(?! (?:${t.not.map(stem).join("|")})))`,
      )
      .join("|")})(?![\\p{L}\\p{N}])`,
    "u",
  );
const termOf = (terms: Term[], m: RegExpExecArray) => {
  const t = terms[m.slice(1).findIndex((g) => g !== undefined)];
  return (typeof t === "string" ? t : t?.t)?.replace(/\*/g, "") ?? m[0];
};

const PARCEL = [
  "inpost",
  "paczkomat*",
  "olx",
  "allegro",
  "vinted",
  "dpd",
  "dhl",
  "poczt*",
  "orlen",
  "zabk*",
  "odbior*",
  "nadani*",
  "przesylk*",
  "paczk*",
  "dostaw*",
  "wysylk*",
];

const DISGUISED: Term[] = [
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
  "cvv*",
  "cvc*",
  "kod* z karty",
  { t: "kod* z aplikacji", not: PARCEL },
  "kod* do platnosci",
  "kod* platnosci",
  { t: "kod* potwierdzenia", not: PARCEL },
  { t: "kod* do potwierdzenia", not: PARCEL },
  "whatsapp*",
  "whatsap*",
  "whatsup*",
  "watsap*",
  // "Wsp." is short for much else; as an app, it's where to write.
  "na wsp",
  "przez wsp",
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
const DISGUISED_RE = termsRe(DISGUISED);

// Money before the item is seen, which buyer protection doesn't cover.
const DEPOSIT: Term[] = [
  "zaliczk*",
  "zadat*",
  "kaucj*",
  "przedplat*",
  "platn* rezerwacj*",
  "rezerwacj* platn*",
  "oplat* rezerwacyjn*",
  "oplat* za rezerwacj*",
  "zaplac* za rezerwacj*",
  "wplac* za rezerwacj*",
  "wplat* za rezerwacj*",
  "deposit*",
  "down payment",
];
const DEPOSIT_RE = termsRe(DEPOSIT);

/** Payment, delivery or the item gone wrong after a deal, or a threat to take it further. */
const DISPUTE: Term[] = [
  "zwrot*",
  "zwroc*",
  "reklamacj*",
  "spor",
  "sporu",
  "oszust*",
  "oszuk*",
  "naciag*",
  "policj*",
  "prokurat*",
  "pozew",
  "pozw*",
  "nie zaplacil*",
  "nie zaplacon*",
  "brak platnosci",
  "brak wplaty",
  "nie dotarl*",
  "nie doszl*",
  "nie przyszl*",
  "nie otrzymal*",
  "nie dostal*",
  "uszkodz*",
  "zepsut*",
  "niezgodn*",
  "pust* paczk*",
  "pust* karton*",
  "refund*",
  "dispute*",
  "chargeback",
  "scam*",
  "not received",
  "never arrived",
  "wrong item",
  "damaged",
  "report*",
];
const DISPUTE_RE = termsRe(DISPUTE);

export const disputed = (text: string) => DISPUTE_RE.test(fold(text));

/** A card's details, unless it's a graphics, memory, SIM or warranty card's. */
const CARD_KINDS = [
  "graficzn*",
  "gwarancyjn*",
  "pamieci",
  "sd",
  "microsd",
  "sim",
  "sieciow*",
  "dzwiekow*",
  "muzyczn*",
  "rozszerzen*",
  "graphics",
  "memory",
  "sound",
  "video",
];
const CARD: Term[] = [
  "dane karty",
  "danych karty",
  "dane do karty",
  "dane z karty",
  "numer* karty",
  "nr karty",
  "nr. karty",
  "card number",
  "card details",
].map((t) => ({ t, not: CARD_KINDS }));
const CARD_RE = termsRe(CARD);
const CARD_ASKED = termsRe([
  "podaj*",
  "przeslij*",
  "wyslij*",
  "platnicz*",
  "kredytow*",
  "debetow*",
  "cvv*",
  "cvc*",
  "kod*",
  "blik*",
  "zaplat*",
  "platnos*",
  "credit",
  "debit",
  "send",
]);

function disguised(text: string): string | null {
  const folded = fold(text);
  const m = DISGUISED_RE.exec(folded);
  if (m) return termOf(DISGUISED, m);
  const card = CARD_RE.exec(folded);
  return card && CARD_ASKED.test(folded) ? termOf(CARD, card) : null;
}

// Only numbers whose IBAN check digits add up: a parcel's number is 24 digits, and a serial number can
// look like an IBAN.
const ACCOUNT =
  /(?<![\p{L}\p{N}])(?:(?:PL ?)?\d{2}(?:[ -]?\d{4}){6}|[A-Z]{2}\d{2}(?: ?[A-Z\d]{4}){3,7}(?: ?[A-Z\d]{1,3})?)(?![\p{L}\p{N}])/gu;
const digits = (s: string) => s.replace(/\D/g, "");

function ibanChecks(raw: string): boolean {
  let s = raw.replace(/[\s-]/g, "").toUpperCase();
  if (/^\d{26}$/.test(s)) s = `PL${s}`;
  if (s.startsWith("PL") && s.length !== 28) return false;
  let rem = 0;
  for (const ch of s.slice(4) + s.slice(0, 4))
    for (const d of /\d/.test(ch) ? ch : String(ch.charCodeAt(0) - 55))
      rem = (rem * 10 + Number(d)) % 97;
  return rem === 1;
}

/** The marketplace's own name as a bare address ("OLX.pl", "www.olx.pl."), which isn't a link anywhere. */
function ownSite(link: string): boolean {
  try {
    const bare = link.replace(/[.,;:!?)\]]+$/, "");
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(bare) ? bare : `https://${bare}`);
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    return MARKETPLACE_HOSTS.includes(host) && u.pathname === "/" && !u.search && !u.hash;
  } catch {
    return false;
  }
}

export function scamSignals(text: string, allow: MandateContact[]): string[] {
  const out: string[] = [];
  const off = OFF_PLATFORM.exec(text)?.[0] ?? disguised(text);
  if (off) out.push(`payment or talk off the platform (“${off}”)`);
  if (DEPOSIT_RE.test(fold(text))) out.push("a request for a deposit");
  const account = [...plain(text).matchAll(ACCOUNT)].map((m) => m[0]).find(ibanChecks);
  if (account) out.push(`a bank account number (“${account}”)`);
  const link = linksIn(text).find((l) => !ownSite(l));
  if (link) out.push(`a link (“${link}”)`);
  for (const c of contactsIn(text))
    if (
      !allow.includes(c.kind) &&
      !(c.kind === "apps" && off) &&
      !(c.kind === "phone" && account && digits(account).includes(digits(c.raw)))
    )
      out.push(`${CONTACT_NAMES[c.kind]} (“${c.raw}”)`);
  return out;
}
