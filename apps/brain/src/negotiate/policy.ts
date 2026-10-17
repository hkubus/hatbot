// negotiate_send's policy (PLAN.md §16.3), in code rather than by Haiku: inside the mandate a message
// goes without asking; outside it, it asks; the pace limits hold either way. Pure, so it can be tested
// case by case. What it can't read for certain, such as an amount in words, asks too: it never sends on a
// guess.
import type { MandateContact, Negotiation, Stated } from "@hatbot/shared";
import { askAlways, block, covered, type Verdict } from "../plugins/plugin";
import { collapse, sameHost } from "./gate";

/** What one negotiate_send would send. */
export type SendInput = {
  text: string;
  offer: number | null;
  agree: boolean;
  stated: Stated | null;
};

/** What the policy needs to know beyond the negotiation, read from the database and the clock. */
export type SendFacts = {
  now: number;
  /** The brain's local hour, 0–23. */
  hour: number;
  /** A message in this negotiation is being sent now. */
  inFlight: boolean;
  /** Nothing has gone to this seller yet: this message starts a conversation. */
  starts: boolean;
  /** Conversations the bot's account started on this marketplace in the last 24 hours. */
  startedToday: number;
  /** When our last message went, if the seller hasn't answered it. */
  unansweredSince: number | null;
};

/** Nothing goes between these hours, local time. */
export const QUIET_HOURS = { from: 22, to: 8 };
/** New conversations per account and marketplace in 24 hours. */
export const NEW_PER_DAY = 10;
/** Two messages in a row, with no reply between, are at least this far apart. */
export const PACE_MS = 2 * 60_000;

const zl = (n: number, currency: string) =>
  `${n.toLocaleString("en-GB", { maximumFractionDigits: 2 })} ${currency === "PLN" ? "zł" : currency}`;

/** The policy for one message: block, ask (why), or allow as covered by the mandate. */
export function sendPolicy(n: Negotiation, input: SendInput, f: SendFacts): Verdict {
  // Blocks: nothing can go, asked or not.
  if (n.status === "awaiting_mandate")
    return block(`Negotiation #${n.id} waits for the owner to approve its mandate.`);
  if (n.status !== "open") return block(`Negotiation #${n.id} is ${n.status}.`);
  if (f.inFlight)
    return block(`A message in negotiation #${n.id} is being sent already. Wait for it.`);
  if (n.conversationUrl && !sameHost(n.conversationUrl, n.listingUrl))
    return block("The recorded conversation isn't on the listing's site, so nothing goes there.");
  if (input.agree && input.offer === null) return block("Put the price you agree to in offer.");
  if (quiet(f.hour))
    return block(
      `Nothing goes to sellers between ${pad(QUIET_HOURS.from)}:00 and ${pad(QUIET_HOURS.to)}:00. Send it after ${pad(QUIET_HOURS.to)}:00.`,
    );
  if (f.starts && f.startedToday >= NEW_PER_DAY)
    return block(
      `This account has started ${f.startedToday} conversations on ${marketplaceOf(n)} in the last 24 hours, the most it starts in a day. Try again tomorrow.`,
    );
  if (f.unansweredSince !== null && f.now - f.unansweredSince < PACE_MS)
    return block(
      "Your last message went less than two minutes ago and the seller hasn't answered. Give them time.",
    );

  // Asks: outside the mandate, or something the mandate doesn't cover.
  const why = outside(n, input, f.now);
  return why.length
    ? askAlways(`Outside the mandate: ${why.join(" ")}`, "send")
    : covered("Within the mandate you approved");
}

const pad = (h: number) => String(h).padStart(2, "0");
const quiet = (hour: number) => hour >= QUIET_HOURS.from || hour < QUIET_HOURS.to;
const marketplaceOf = (n: Negotiation) => n.listingKey.split(":")[0] ?? "the marketplace";

/** Why a message is outside the mandate, sentence by sentence; empty when it's inside. */
export function outside(n: Negotiation, input: SendInput, now: number): string[] {
  const m = n.mandate;
  const buying = n.role === "buy";
  const beyond = (x: number) => (buying ? x > m.limit : x < m.limit);
  const limit = `${buying ? "the ceiling" : "the floor"} of ${zl(m.limit, m.currency)}`;
  const why: string[] = [];
  if (Date.parse(m.expiresAt) <= now)
    why.push(`The mandate ran out on ${m.expiresAt.slice(0, 16).replace("T", " ")} UTC.`);
  if (input.offer !== null && beyond(input.offer))
    why.push(
      `${input.agree ? "Agreeing to" : "Offering"} ${zl(input.offer, m.currency)} is ${buying ? "above" : "below"} ${limit}.`,
    );
  const max = input.stated?.max;
  if (max !== undefined && max !== null && beyond(max))
    why.push(
      `It tells the seller ${zl(max, m.currency)} is our ${buying ? "most" : "least"}, ${buying ? "above" : "below"} ${limit}.`,
    );
  const text = plain(input.text);
  const amounts = amountsIn(text, n.title, n.asking).filter((a) =>
    buying ? Math.max(...a.values) > m.limit : Math.min(...a.values) < m.limit,
  );
  if (amounts.length)
    why.push(
      `The text says ${amounts.map((a) => `"${a.raw}"`).join(", ")}, ${buying ? "above" : "below"} ${limit}.`,
    );
  const words = numberWords(text);
  if (words.length)
    why.push(
      `The text writes an amount in words (${words.map((w) => `"${w}"`).join(", ")}), which can't be checked against the mandate.`,
    );
  const spaced = spacedDigits(text);
  if (spaced.length)
    why.push(
      `The text spells a number out digit by digit ("${spaced[0]}"), which can't be checked against the mandate.`,
    );
  const contacts = contactsIn(text).filter((c) => !m.allow.includes(c.kind));
  for (const c of contacts) why.push(`It carries ${CONTACT_NAMES[c.kind]} ("${c.raw}").`);
  const links = linksIn(text);
  if (links.length) why.push(`It carries a link ("${links[0]}").`);
  return why;
}

const CONTACT_NAMES: Record<MandateContact, string> = {
  phone: "a phone number",
  email: "an e-mail address",
  address: "an address",
  apps: "another app",
};

// ——— Amounts ———

/** Currency next to a number: it's money, whatever else it looks like. */
const CURRENCY = /^\s?(?:zł|zl|złotych|złote|złoty|pln|eur|euro|€|\$|usd)(?![\p{L}])/iu;
const CURRENCY_BEFORE = /(?:(?<![\p{L}])(?:zł|zl|pln|eur)|€|\$|usd)\s?$/iu;
/** Thousands after a number: 1,4k, 1.5 tys., 2 grand, 2 koła, 3 kafle. */
const THOUSANDS =
  /^\s?(?:k|tys\.?|tyś\.?|tysi[ąa]c\p{L}*|tysi[ęe]cy|tysiak\p{L}*|thousands?|grand|kafl\p{L}*|kafel|patyk\p{L}*|patol\p{L}*|ko[łl][ao]|k[óo][łl])(?![\p{L}])/iu;
/** Hundreds after a number: 15 stów, 14 stówek, 12 setek, fourteen hundred. */
const HUNDREDS = /^\s?(?:st[óo]w\p{L}*|stow[aeky]\p{L}*|setk\p{L}*|setek|hundreds?)(?![\p{L}])/iu;
/**
 * What a number counts when this word follows it: not money. No one-letter units: "2000 w gotówce" is
 * money, not watts.
 */
const UNIT =
  /^\s?(?:%|procent\p{L}*|gb|tb|mb|kb|mhz|ghz|hz|mah|wh|cm|mm|km|kg|ml|cali|cale|cal|szt\.?|sztuk\p{L}*|dni|dzień|dnia|godz\.?|godzin\p{L}*|minut\p{L}*|sek\.?|tyg\.?|tygodni\p{L}*|mies\.?|miesi\p{L}*|lat|lata|fps|rpm|gen\.?|generacji|rdzeni\p{L}*|bit|bitów|days?|hours?|weeks?|months?|years?|pcs|pieces?|inch\p{L}*)(?![\p{L}\p{N}])/iu;
/** A year after these words. Not w, z or od on their own: "w 2000" is as likely money as a year. */
const YEAR_BEFORE = /(?:^|[^\p{L}])(?:rok|roku|rocznik|in|from|since|year)\s$/iu;
const YEAR_AFTER = /^\s?(?:r\.|r(?![\p{L}])|rok|roku)/iu;

/** Dates and times, blanked before numbers are read: their digits aren't amounts or phone numbers. */
const blankDates = (text: string) =>
  text
    .replace(/(?<!\d)\d{1,2}[./-]\d{1,2}[./-]\d{2,4}(?!\d)/g, (x) => " ".repeat(x.length))
    .replace(/(?<!\d)\d{1,2}:\d{2}(?!\d)/g, (x) => " ".repeat(x.length));

/** A decimal digit's value in any script: Unicode keeps each script's 0–9 together and in order. */
function digitValue(d: string): number {
  let cp = d.codePointAt(0) ?? 0;
  let n = 0;
  while (/\p{Nd}/u.test(String.fromCodePoint(cp - 1))) {
    cp--;
    n++;
  }
  return n % 10;
}

/** Latin, Cyrillic and Greek letters that pass for 0 and 1 inside a number: 15OO, l500. */
const LOOK_ALIKE = /(?<![\p{L}\p{N}])[\dOoОоΟοlIІіӀӏ]*\d[\dOoОоΟοlIІіӀӏ]*(?![\p{L}\p{N}])/gu;

/**
 * A message as the policy reads it: as the gate compares it (NFKC, no invisible characters), with every
 * script's digits as 0–9, and O or l among a number's digits read as 0 or 1.
 */
export function plain(text: string): string {
  return collapse(text)
    .replace(/\p{Nd}/gu, (d) => (d >= "0" && d <= "9" ? d : String(digitValue(d))))
    .replace(/٫/g, ".")
    .replace(/٬/g, ",")
    .replace(LOOK_ALIKE, (w) => w.replace(/[OoОоΟο]/g, "0").replace(/[lIІіӀӏ]/g, "1"));
}

/** Digits written one by one, "1 5 0 0": not something to read as a number on a guess. */
export function spacedDigits(text: string): string[] {
  return [...blankDates(plain(text)).matchAll(/(?<!\d)\d(?:[ .\-_·*]\d(?!\d)){2,}/g)].map(
    (m) => m[0],
  );
}

/** A number written in the text, with every value its separators could mean. */
export type Amount = { raw: string; values: number[] };

/** Words that make the number after them, or after the model name that follows them, a price. */
const PRICE_WORDS = new Set(
  "za do od po cena cenę cene ceny cenie cenka koszt kosztuje kwota kwotę kwote kwocie dam daję daje dać dac płacę place zapłacę zaplace oferuję oferuje proponuję proponuje biorę biore wezmę wezme max maks maksymalnie najwyżej najwyzej budżet budzet razem łącznie lacznie for pay price offer at only tylko total".split(
    " ",
  ),
);
const priceWord = (w: string | undefined) => w !== undefined && PRICE_WORDS.has(w.toLowerCase());
/** Letters that look like a model's name: RTX, B, iPhone; not a word that merely starts a sentence. */
const modelLike = (w: string) => /^\p{Lu}+$/u.test(w) || /\p{Lu}/u.test(w.slice(1));
/** The last word in `s`, if only spaces and punctuation follow it. */
const lastWord = (s: string) => /(\p{L}+)[^\p{L}\p{N}]*$/u.exec(s)?.[1];

/**
 * The amounts in a message: numbers that could be prices. Not: numbers glued to a model's letters
 * (RTX3070, 16GB, i7-12700), a model number after the word it follows in the title or after a capitalised
 * word from it (RTX 3080), units (8 GB, 3 dni), times, dates, phone numbers and likely years. A model
 * number stays an amount when it's the asking price or follows a price word ("za RTX 1500", "cena 1500").
 * Each separator is read every way it could be (1.500 is 1500 or 1.5), so the cap can't be dodged by the
 * format.
 */
export function amountsIn(text: string, title: string, asking: number | null = null): Amount[] {
  const words = title.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  /** "hexagon 2000": a word in the title and the number after it, unless that's a price ("cena 1500"). */
  const models = new Set(
    words.slice(1).flatMap((w, i) => {
      const word = words[i] ?? "";
      return /^\d+$/.test(w) && !priceWord(word) && Number(w) !== asking
        ? [`${word.toLowerCase()} ${w}`]
        : [];
    }),
  );
  const caps = new Set(words.filter((w) => w.length >= 2 && /^\p{Lu}+$/u.test(w) && !priceWord(w)));
  let s = blankDates(plain(text));
  for (const p of phonesIn(s)) s = s.replace(p, " ".repeat(p.length));

  const out: Amount[] = [];
  /** One number at `index`: an amount unless something around it says it isn't. */
  const judge = (raw: string, index: number, values: number[], parts: number) => {
    const before = s.slice(0, index);
    const after = s.slice(index + raw.length);
    const money = CURRENCY.test(after) || CURRENCY_BEFORE.test(before);
    // The asking price is a price wherever it stands, even after a model's name.
    const asked = asking !== null && values.includes(asking);
    if (!money && !asked) {
      // RTX3070, iPhone12, i7, b550: glued to a model's letters, unless they're a price word (za1500).
      const glued = /\p{L}+$/u.exec(before)?.[0];
      if (
        glued &&
        !priceWord(glued) &&
        !priceWord(lastWord(before.slice(0, -glued.length))) &&
        (modelLike(glued) ||
          models.has(`${glued.toLowerCase()} ${raw}`) ||
          (glued.length <= 2 && values.every((v) => v < 1000)))
      )
        return;
      // i7-12700, RX-580: after a hyphen glued to a model's letters.
      const hyphened = /(?<![\p{L}\p{N}])(\p{L}[\p{L}\p{N}]*)-$/u.exec(before)?.[1];
      if (hyphened && !priceWord(hyphened)) return;
    }
    const thousands = THOUSANDS.exec(after)?.[0] ?? HUNDREDS.exec(after)?.[0] ?? null;
    const scale = thousands === null ? 1 : HUNDREDS.test(thousands) ? 100 : 1000;
    if (/^\p{L}/u.test(after) && !money && thousands === null) return;
    if (!money && thousands === null) {
      if (UNIT.test(after)) return;
      const word = /(\p{L}+)[\s-]$/u.exec(before)?.[1];
      if (word && !asked && !priceWord(word)) {
        if (models.has(`${word.toLowerCase()} ${raw}`)) return;
        const prev = lastWord(before.slice(0, before.lastIndexOf(word)));
        if (caps.has(word) && !priceWord(prev)) return;
      }
      const year = Number(raw);
      if (
        !asked &&
        parts === 1 &&
        /^\d{4}$/.test(raw) &&
        year >= 1990 &&
        year <= 2039 &&
        (YEAR_BEFORE.test(before) || YEAR_AFTER.test(after))
      )
        return;
    }
    out.push({
      raw: raw + (thousands ?? ""),
      values: values.map((v) => Math.round(v * scale * 100) / 100),
    });
  };

  // Digits joined by . , ' \u2019 ` _ \u00b7, or by a space before exactly three more: 1 400, 1.400,50, 1\u2019500.
  const re = /\d+(?:(?:[.,'\u2019`\u00b4_\u00b7]|[ ](?=\d{3}(?!\d)))\d+)*/g;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    const raw = m[0];
    const groups = raw.split(/[.,'\u2019`\u00b4_\u00b7 ]/);
    const seps = raw.match(/[.,'\u2019`\u00b4_\u00b7 ]/g) ?? [];
    const values = readings(groups, seps);
    if (values.length) {
      judge(raw, m.index, values, groups.length);
      continue;
    }
    // 1400,1300: separate numbers, each judged where it stands.
    let at = m.index;
    for (const g of groups) {
      const i = s.indexOf(g, at);
      judge(g, i, [Number(g)], 1);
      at = i + g.length;
    }
  }
  return out;
}

/**
 * What a run of digits and separators could mean, as one number: with thousands separators, or with a
 * decimal part, each where it's a plausible way to write one. Empty when it's several numbers.
 */
function readings(groups: string[], seps: string[]): number[] {
  if (groups.length === 1) return [Number(groups[0])];
  const values = new Set<number>();
  const head = groups[0] ?? "";
  // 1 400, 1.400, 1,400, 1'400: thousands.
  if (head.length <= 3 && groups.slice(1).every((g) => g.length === 3) && new Set(seps).size === 1)
    values.add(Number(groups.join("")));
  // 1.5, 1,5, 1.400,50, 1 400,50: the last separator a decimal point.
  const last = seps.at(-1) ?? "";
  const tail = groups.at(-1) ?? "";
  const whole = groups.slice(0, -1);
  const wholeOk =
    whole.length === 1 ||
    ((whole[0]?.length ?? 0) <= 3 &&
      whole.slice(1).every((g) => g.length === 3) &&
      new Set(seps.slice(0, -1)).size === 1 &&
      seps[0] !== last);
  if ((last === "." || last === ",") && tail.length <= 3 && wholeOk)
    values.add(Number(`${whole.join("")}.${tail}`));
  return [...values];
}

/** Amounts written out in words, in English or Polish, slang included. */
const NUMBER_WORDS =
  /(?<![\p{L}])(?:hundreds?|thousands?|grand|tysiąc\p{L}*|tysiac\p{L}*|tysięcy|tysiecy|tysiak\p{L}*|tys\.?(?![\p{L}])|patyk\p{L}*|patol\p{L}*|kafel\p{L}*|kafl\p{L}*|stów\p{L}*|stow[aeyk]\p{L}*|stówk\p{L}*|setk\p{L}*|setek|sto|dwieście|dwiescie|trzysta|czterysta|pięćset|piecset|pi[ńn]cet\p{L}*|piencet|sześćset|szescset|siedemset|osiemset|dziewięćset|dziewiecset|dych\p{L}*|dysz\p{L}*|(?:p[óo][łl]tor\p{L}*|p[óo][łl]|jed(?:en|na|no)|dwa|dwie|trzy|cztery|pi[ęe][ćc]|kilka|par[ęe])\s+(?:ko[łl][ao]|k[óo][łl]))(?![\p{L}])/giu;

/** Number words not right after digits: "1,5 tys." is read as a number, "półtora tysiąca" isn't. */
export function numberWords(raw: string): string[] {
  const text = plain(raw);
  const out: string[] = [];
  for (const m of text.matchAll(NUMBER_WORDS)) {
    const before = text.slice(0, m.index);
    if (/\d\s?$/.test(before)) continue;
    out.push(m[0]);
  }
  return out;
}

// ——— Contacts and links ———

/** Phone numbers: nine or more digits, with or without spaces, dashes, dots or a +48. */
export function phonesIn(text: string): string[] {
  return [...text.matchAll(/(?:\+|00)?\d(?:[\s \-.()/]{0,2}\d){8,}/g)].map((m) => m[0]);
}

const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/u;
/** name at gmail dot com, name(at)wp.pl, name małpa onet kropka pl. */
const EMAIL_SPELT =
  /[\p{L}\p{N}._%+-]+\s*(?:\(at\)|\[at\]|\{at\}|\(małpa\)|\s+małpa\s+|\s+malpa\s+|\s+at\s+(?=(?:gmail|wp|onet|o2|interia|yahoo|outlook|hotmail|icloud|proton|op|gazeta|tlen|vp)(?![\p{L}])))\s*[\p{L}\p{N}-]+\s*(?:\.|\(dot\)|\[dot\]|\s+dot\s+|\s+kropka\s+)\s*\p{L}{2,}/iu;
const ADDRESS = [
  /(?<![\p{L}.])(?:ul|al|os|pl)\.\s*\p{Lu}/u,
  /(?<![\p{L}])(?:ulica|ulicy|ulicę|aleja|alei|aleję|osiedle|osiedlu)\s+\p{Lu}/u,
  /\p{Lu}[\p{L}'-]+\s+(?:Street|St\.|Road|Rd\.|Avenue|Ave\.|Lane|Drive|Boulevard)(?![\p{L}])/u,
  /(?<![\d-])\d{2}-\d{3}(?![\d-])/u,
];
const APPS =
  /(?<![\p{L}])(?:whats\s?app\p{L}*|wa\.me|telegram\p{L}*|t\.me|signal\p{L}*|viber\p{L}*|messenger\p{L}*|facebook\p{L}*|fb\.com|fejs\p{L}*|instagram\p{L}*|insta|snapchat\p{L}*|wechat|discord\p{L}*|skype\p{L}*|sms\p{L}*|esem\p{L}*|imessage)(?![\p{L}])/iu;

/** Contact details in a message, by the kind the mandate can allow. */
export function contactsIn(text: string): { kind: MandateContact; raw: string }[] {
  const out: { kind: MandateContact; raw: string }[] = [];
  const phone = phonesIn(blankDates(text))[0];
  if (phone) out.push({ kind: "phone", raw: phone.trim() });
  const email = EMAIL.exec(text)?.[0] ?? EMAIL_SPELT.exec(text)?.[0];
  if (email) out.push({ kind: "email", raw: email });
  for (const re of ADDRESS) {
    const a = re.exec(text);
    if (a) {
      out.push({
        kind: "address",
        raw: text.slice(a.index, a.index + 40).split(/[,;\n]/)[0] ?? "",
      });
      break;
    }
  }
  const app = APPS.exec(text)?.[0];
  if (app) out.push({ kind: "apps", raw: app });
  return out;
}

/** Links: an address with a scheme, www., or a domain. They always ask. */
export function linksIn(text: string): string[] {
  const s = text.replace(EMAIL, " ");
  return [
    ...s.matchAll(
      /(?:https?:\/\/|www\.)\S+|(?<![\p{L}\p{N}@.-])[\p{L}\p{N}-]+\.(?:pl|com|net|org|eu|io|me|ly|cz|de|uk|info|biz|link|app|xyz|shop|store|site|online|top|click)(?:\/\S*)?(?![\p{L}\p{N}])/giu,
    ),
  ].map((m) => m[0]);
}
