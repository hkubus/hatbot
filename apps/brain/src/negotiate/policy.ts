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
  const extra = allowance(m.delivery);
  for (const t of totalsIn(text, n.title, n.asking)) {
    if (t.kind === "each")
      why.push(
        `It prices each item ("${t.raw}"), so what it comes to can't be checked against the mandate.`,
      );
    // Selling, a total only adds up to more, so it's the parts that can be below the floor.
    else if (buying && t.kind === "product" && t.total > m.limit)
      why.push(`It comes to ${zl(t.total, m.currency)} ("${t.raw}"), above ${limit}.`);
    else if (buying && t.kind === "sum" && t.total > m.limit + extra)
      why.push(
        `It adds up to ${zl(t.total, m.currency)} ("${t.raw}"), above ${limit}${extra ? ` and the ${zl(extra, m.currency)} the delivery terms allow on top` : ""}.`,
      );
  }
  const foreign = [
    ...new Set(currenciesIn(text).flatMap((c) => (c.code === m.currency ? [] : [`"${c.raw}"`]))),
  ];
  if (foreign.length)
    why.push(
      `It names another currency (${foreign.join(", ")}), and the mandate's amounts are in ${m.currency}.`,
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
  for (const p of paymentsIn(text))
    if (!paymentsIn(m.delivery).some((d) => d.name === p.name))
      why.push(
        `It brings up a way to pay that the mandate's terms don't name: ${p.name} ("${p.raw}").`,
      );
  const pickup = PICKUP.exec(text)?.[0];
  if (pickup && !(PICKUP.test(m.delivery) && !NO_PICKUP.test(m.delivery)))
    why.push(
      `It brings up picking up or meeting in person ("${pickup}"), which the delivery terms ("${m.delivery}") don't allow.`,
    );
  const shipping = SHIPPING.exec(text)?.[0];
  if (shipping && !(SHIPPING.test(m.delivery) && !NO_SHIPPING.test(m.delivery)))
    why.push(
      `It brings up shipping ("${shipping}"), which the delivery terms ("${m.delivery}") don't include.`,
    );
  const paid = PAID.exec(text)?.[0];
  if (paid) why.push(`It says something was paid or sent ("${paid}").`);
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

/** Currencies by code: the words (regex) and signs they're written with. */
const MONEY: { code: string; words: string; signs?: string }[] = [
  { code: "PLN", words: "zł|zl|złot\\p{L}*|zlot\\p{L}*|pln|zeta" },
  // Euro RTV AGD is a shop, where receipts come from.
  { code: "EUR", words: "eur|euro(?!\\s*(?:rtv|agd|net))|eurasów|ojro", signs: "€" },
  { code: "USD", words: "usd|dolar\\p{L}*|dollar\\p{L}*|bucks", signs: "\\$" },
  { code: "GBP", words: "gbp|funt\\p{L}*|pounds?|quid", signs: "£" },
  { code: "CZK", words: "czk|kč|korun\\p{L}*" },
  { code: "CHF", words: "chf|frank(?:i|a|ów|ach|ami)?|francs?" },
  { code: "UAH", words: "uah|hrywn\\p{L}*", signs: "₴" },
  { code: "HUF", words: "huf|forint\\p{L}*" },
  { code: "DKK", words: "dkk" },
  { code: "RUB", words: "rubl\\p{L}*", signs: "₽" },
  { code: "JPY", words: "jpy", signs: "¥" },
  { code: "BTC", words: "btc|bitcoin\\p{L}*", signs: "₿" },
  { code: "ETH", words: "eth|ethereum" },
  { code: "USDT", words: "usdt|tether" },
];
const moneyWords = MONEY.map((c) => c.words).join("|");
const moneySigns = MONEY.flatMap((c) => (c.signs ? [c.signs] : [])).join("|");
/** Currency next to a number: it's money, whatever else it looks like. */
const CURRENCY = new RegExp(`^\\s?(?:(?:${moneyWords})(?![\\p{L}])|${moneySigns})`, "iu");
const CURRENCY_BEFORE = new RegExp(`(?:(?<![\\p{L}])(?:${moneyWords})|${moneySigns})\\s?$`, "iu");

/** Currencies a message names, by code, with the amount next to each when there is one. */
export function currenciesIn(text: string): { code: string; raw: string }[] {
  const s = plain(text);
  const out: { code: string; raw: string }[] = [];
  for (const c of MONEY) {
    const re = new RegExp(
      `(?<![\\p{L}])(?:${c.words})(?![\\p{L}])${c.signs ? `|${c.signs}` : ""}`,
      "giu",
    );
    for (const m of s.matchAll(re)) {
      const at = m.index ?? 0;
      const before = /\d+(?:[.,' ]\d+)*\s?$/.exec(s.slice(0, at))?.[0] ?? "";
      const after = before
        ? ""
        : (/^\s?\d+(?:[.,']\d+)*/.exec(s.slice(at + m[0].length))?.[0] ?? "");
      out.push({ code: c.code, raw: `${before}${m[0]}${after}`.trim() });
    }
  }
  return out;
}
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
  return read(text, title, asking).found.map(({ raw, values }) => ({ raw, values }));
}

/** An amount and where it stands in the text it was read from. */
type Found = Amount & { index: number; end: number; money: boolean };

/** The amounts in `text`, where they stand in `s`: the text as read, dates and phone numbers blanked. */
function read(text: string, title: string, asking: number | null): { s: string; found: Found[] } {
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

  const out: Found[] = [];
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
      index,
      end: index + raw.length + (thousands?.length ?? 0),
      money,
    });
  };

  // Digits joined by . , ' _ a middle dot or another apostrophe, or by a space before exactly three
  // more: 1 400, 1.400,50, 1'500.
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
  return { s, found: out };
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

/** Between two amounts, makes them one sum: 1100+400, 1100 teraz i 400 przy odbiorze, dorzucę 400. */
const JOIN =
  /\+|(?<![\p{L}])(?:plus|i|oraz|dorzuc\p{L}*|do[łl]o[żz]\p{L}*|dop[łl]ac\p{L}*|do\s+tego|ponadto|jeszcze|and|extra|on\s+top)(?![\p{L}])/iu;
/** Between two amounts, keeps them apart: they're alternatives, not a sum. */
const APART = /(?<![\p{L}])(?:albo|lub|czy|or|zamiast|instead|nie|not)(?![\p{L}])/iu;
/** A number times another: 2 x 750, 2×750, 2 razy po 750, 2 sztuki po 750, 750 x 2. */
const MULTIPLY =
  /(?<![\d.,])(\d+(?:[.,]\d+)*)\s*(?:x|×|\*|razy(?:\s+po)?|times|szt\.?(?:\s+po)?|sztuk\p{L}*(?:\s+po)?|pcs\.?|pieces?)\s*(?:po\s+|à\s*|@\s*)?(\d+(?:[.,]\d+)*)/giu;
/** After an amount: it's the price of each item, so the total depends on how many. */
const EACH =
  /^\s?(?:(?:zł|zl|pln|złotych)\.?\s?)?(?:za\s+(?:sztuk[eęi]|szt\.?|każd\p{L}*|jedn\p{L}*)|\/\s?szt\.?|każd[aey]|each|apiece|per\s+(?:item|piece|unit|one))(?![\p{L}])/iu;
/** More than one item, so "po 750" is a price each. */
const SEVERAL =
  /(?<![\p{L}])(?:obie|oba|obydw\p{L}*|dwie|dwa|trzy|cztery|both|two|three|four)(?![\p{L}])/iu;

/** Amounts in one message that make one total: added up, multiplied, or a price for each of several. */
export type Total = { raw: string; total: number; kind: "sum" | "product" | "each" };

/** What the amounts in a message come to together, where they're joined into one total. */
export function totalsIn(text: string, title: string, asking: number | null = null): Total[] {
  const { s, found } = read(text, title, asking);
  const out: Total[] = [];
  const most = (a: Amount) => Math.max(...a.values);
  const quote = (from: number, to: number) => s.slice(from, to).replace(/\s+/g, " ").trim();

  let group: Found[] = [];
  const flush = () => {
    const first = group[0];
    const last = group.at(-1);
    if (group.length > 1 && first && last)
      out.push({
        raw: quote(first.index, last.end).slice(0, 80),
        total: group.reduce((sum, a) => sum + most(a), 0),
        kind: "sum",
      });
  };
  for (const a of found) {
    const prev = group.at(-1);
    const between = prev ? s.slice(prev.end, a.index) : "";
    if (prev && JOIN.test(between) && !APART.test(between)) group.push(a);
    else {
      flush();
      group = [a];
    }
  }
  flush();

  for (const m of s.matchAll(MULTIPLY)) {
    const after = s.slice((m.index ?? 0) + m[0].length);
    const thousands = THOUSANDS.test(after);
    // 30x40 cm, 2x8GB: sizes and parts, not money. RTX 3070 x 2: a model, twice.
    if (!thousands && (UNIT.test(after) || (/^\p{L}/u.test(after) && !CURRENCY.test(after))))
      continue;
    const model = /(\p{L}+)[\s-]?$/u.exec(s.slice(0, m.index))?.[1];
    if (model && modelLike(model) && !priceWord(model)) continue;
    const factor = (x: string) => {
      const groups = x.split(/[.,]/);
      return Math.max(
        Number(x.replace(",", ".")) || 0,
        ...readings(groups, x.match(/[.,]/g) ?? []),
      );
    };
    out.push({
      raw: m[0],
      total: factor(m[1] ?? "0") * factor(m[2] ?? "0") * (thousands ? 1000 : 1),
      kind: "product",
    });
  }

  for (const a of found) {
    const each =
      EACH.test(s.slice(a.end)) ||
      (/(?<![\p{L}])po\s$/iu.test(s.slice(0, a.index)) && (a.money || SEVERAL.test(s)));
    if (each) out.push({ raw: quote(a.index, a.end), total: most(a), kind: "each" });
  }
  return out;
}

/** Shipping on top of the price that the mandate's delivery terms allow: "OLX delivery, up to 20 zł". */
export function allowance(delivery: string): number {
  return Math.max(
    0,
    ...read(delivery, "", null)
      .found.filter((a) => a.money)
      .flatMap((a) => a.values),
  );
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

// ——— Paying and delivery ———

/** Ways to pay. Bringing one up asks unless the mandate's delivery terms name it. */
const PAYMENTS: { name: string; re: RegExp }[] = [
  { name: "BLIK", re: /(?<![\p{L}])blik\p{L}*/iu },
  {
    name: "a bank transfer",
    re: /(?<![\p{L}])(?:przelew\p{L}*|przela[ćcłl]\p{L}*|przelej\p{L}*|przelej[eę]|kont[aou]?|koncie|kontem|iban|transfer\p{L}*)(?![\p{L}])/iu,
  },
  { name: "cash", re: /(?<![\p{L}])(?:got[óo]wk\p{L}*|got[óo]wce|cash)(?![\p{L}])/iu },
  { name: "cash on delivery", re: /(?<![\p{L}])pobrani\p{L}*/iu },
  { name: "PayPal", re: /(?<![\p{L}])pay\s?pal\p{L}*/iu },
  { name: "Revolut", re: /(?<![\p{L}])revolut\p{L}*/iu },
  {
    name: "crypto",
    re: /(?<![\p{L}])(?:krypto\p{L}*|crypto\p{L}*|bitcoin\p{L}*|btc|usdt|ethereum)(?![\p{L}])/iu,
  },
  {
    name: "a money transfer service",
    re: /(?<![\p{L}])(?:western\s+union|moneygram|skrill|payoneer)(?![\p{L}])/iu,
  },
  {
    name: "a deposit",
    re: /(?<![\p{L}])(?:zaliczk\p{L}*|zadat(?:ek|ku|kiem)|przedp[łl]at\p{L}*|deposit\p{L}*|prepay\p{L}*|upfront|up\s+front)(?![\p{L}])/iu,
  },
];

/** The ways to pay a text brings up. */
export function paymentsIn(raw: string): { name: string; raw: string }[] {
  const text = plain(raw);
  return PAYMENTS.flatMap((p) => {
    const m = p.re.exec(text);
    return m ? [{ name: p.name, raw: m[0] }] : [];
  });
}

/** Picking up or meeting in person. */
const PICKUP =
  /(?<![\p{L}])(?:odbi[óo]r\p{L}*|odbier\p{L}*|odebra\p{L}*|osobi[śs]cie|spotka\p{L}*|podjad\p{L}*|podjech\p{L}*|przyjad\p{L}*|przyjech\p{L}*|pick(?:\s+\p{L}+)?(?:\s|-)?up|collect\p{L}*|in\s+person|meet\p{L}*)(?![\p{L}])/iu;
/** Sending it by post or courier. */
const SHIPPING =
  /(?<![\p{L}])(?:wysy[łl]k\p{L}*|przesy[łl]k\p{L}*|kurier\p{L}*|paczkomat\p{L}*|paczk\p{L}*|inpost\p{L}*|dpd|dhl|gls|poczt\p{L}*|dostaw\p{L}*|ship\p{L}*|deliver\p{L}*|courier\p{L}*|parcel\p{L}*|postage)(?![\p{L}])/iu;
/** Delivery terms that rule one out: "no pickup", "shipping only", "tylko odbiór". */
const NO_PICKUP =
  /(?:no|not|without|bez|nie|brak)\s+(?:\p{L}+\s+)?(?:odbi[óo]r\p{L}*|pick(?:\s|-)?up|collection|osobi[śs]cie|in\s+person)|(?:shipping|delivery|wysy[łl]k\p{L}*|przesy[łl]k\p{L}*)\s+only|(?:only|tylko)\s+(?:shipping|delivery|wysy[łl]k\p{L}*|przesy[łl]k\p{L}*)/iu;
const NO_SHIPPING =
  /(?:no|not|without|bez|nie|brak)\s+(?:\p{L}+\s+)?(?:wysy[łl]k\p{L}*|przesy[łl]k\p{L}*|dostaw\p{L}*|shipping|delivery)|(?:pickup|pick-up|collection|odbi[óo]r\p{L}*)\s+only|(?:only|tylko)\s+(?:pickup|pick-up|collection|odbi[óo]r\p{L}*|osobi[śs]cie)/iu;
/** Saying something was paid or sent: only the owner can say that. */
const PAID =
  /(?<![\p{L}])(?:(?:za|o|w|do|prze)?p[łl]aci[łl](?:em|am|[ae][śs]my|y[śs]my)|prze[łl]a[łl](?:em|am|[ae][śs]my)|wys[łl]a[łl](?:em|am|[ae][śs]my)|przes[łl]a[łl](?:em|am|[ae][śs]my)|nada[łl](?:em|am|[ae][śs]my)|(?:za|o)p[łl]acon[eaoy]|przelew\s+(?:poszed[łl]|wys[łl]any|zrobiony|zlecony)|zrobi[łl](?:em|am)\s+przelew|i(?:['’]ve|\s+have)?\s+(?:already\s+)?(?:paid|sent|transferred|wired|shipped|posted)|payment\s+(?:is\s+|has\s+been\s+|was\s+)?(?:sent|made|done|complete\p{L}*)|already\s+paid)(?![\p{L}])/iu;

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
