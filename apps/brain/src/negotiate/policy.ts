// negotiate_send's policy (PLAN.md §16.3), in code rather than by Haiku: inside the mandate a message
// goes without asking; outside it, it asks; the pace limits hold either way. Pure, so it can be tested
// case by case. It fails closed: a message goes on its own only when the check can read all of it and
// finds it inside the mandate. A character outside plain letters, digits and punctuation, a number it
// can't parse, an amount in words, amounts that together pass the limit, and any message that could
// agree to a price past the limit ask. It never sends on a guess.
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
  /**
   * The seller's latest messages, oldest first, each marked `after` when it came after our last message
   * went: a message that agrees without naming its price agrees to theirs.
   */
  seller: { text: string; after: boolean }[];
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
  const accepts = acceptance(input.text);
  if (accepts && !input.agree && input.offer === null)
    return block(
      `It reads as accepting a price ("${accepts}"). If it does, set agree and put that price in offer; if it doesn't, word it so it can't be read that way.`,
    );
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
  const why = outside(n, input, f);
  if (!why.length) return covered("Within the mandate you approved");
  // Money and terms past the mandate are approved in the app, as the mandate is; a message that only
  // carries a link or contact details can be approved from the lock screen.
  const text = plain(input.text);
  const talk =
    contactsIn(text).filter((c) => !n.mandate.allow.includes(c.kind)).length +
    (linksIn(text).length ? 1 : 0);
  return askAlways(
    `Outside the mandate: ${why.join(" ")}`,
    input.agree || why.length > talk ? "purchase" : "send",
  );
}

const pad = (h: number) => String(h).padStart(2, "0");
const quiet = (hour: number) => hour >= QUIET_HOURS.from || hour < QUIET_HOURS.to;
const marketplaceOf = (n: Negotiation) => n.listingKey.split(":")[0] ?? "the marketplace";
const quoted = (xs: string[]) => xs.map((x) => `"${x.slice(0, 40)}"`).join(", ");

/** Why a message is outside the mandate, sentence by sentence; empty when it's inside. */
export function outside(
  n: Negotiation,
  input: SendInput,
  f: Pick<SendFacts, "now" | "seller">,
): string[] {
  const m = n.mandate;
  const buying = n.role === "buy";
  const beyond = (x: number) => (buying ? x > m.limit : x < m.limit);
  const money = (x: number) => zl(x, m.currency);
  const past = buying ? "above" : "below";
  const limit = `${buying ? "the ceiling" : "the floor"} of ${money(m.limit)}`;
  const why: string[] = [];
  if (Date.parse(m.expiresAt) <= f.now)
    why.push(`The mandate ran out on ${m.expiresAt.slice(0, 16).replace("T", " ")} UTC.`);
  if (input.offer !== null && beyond(input.offer))
    why.push(
      `${input.agree ? "Agreeing to" : "Offering"} ${money(input.offer)} is ${past} ${limit}.`,
    );
  const max = input.stated?.max;
  if (max !== undefined && max !== null && beyond(max))
    why.push(
      `It tells the seller ${money(max)} is our ${buying ? "most" : "least"}, ${past} ${limit}.`,
    );

  // Reading: only what can be read for certain counts as inside.
  const odd = unreadableChars(input.text);
  if (odd.length)
    why.push(
      `It has characters that aren't plain letters, digits or punctuation (${odd.join(", ")}), so it can't be read for certain.`,
    );
  const text = plain(input.text);
  const r = read(input.text, n.title, n.asking);
  const amounts = r.found.filter((a) =>
    buying ? Math.max(...a.values) > m.limit : Math.min(...a.values) < m.limit,
  );
  if (amounts.length)
    why.push(`The text says ${amounts.map((a) => `"${a.raw}"`).join(", ")}, ${past} ${limit}.`);
  const spaced = r.unclear.filter((u) => u.spaced).map((u) => u.raw);
  if (spaced.length)
    why.push(
      `The text spells a number out digit by digit (${quoted(spaced)}), which can't be checked against the mandate.`,
    );
  const unclear = [...new Set(r.unclear.filter((u) => !u.spaced).map((u) => u.raw))];
  if (unclear.length)
    why.push(
      `The text writes a number that can't be read for certain (${quoted(unclear)}), so it can't be checked against the mandate.`,
    );
  const spelled = spelledOut(input.text);
  if (spelled.length)
    why.push(
      `It spells a word out letter by letter (${quoted(spelled)}), so it can't be read for certain.`,
    );
  const words = numberWords(input.text);
  if (words.length)
    why.push(
      `The text writes an amount in words (${words.map((w) => `"${w}"`).join(", ")}), which can't be checked against the mandate.`,
    );

  // Totals: every amount in the message may add up, and a product or a price each is what it comes to.
  const t = combine(r);
  for (const e of t.each)
    why.push(
      `It prices each item ("${e.raw}"), so what it comes to can't be checked against the mandate.`,
    );
  if (buying) {
    for (const p of t.products)
      if (p.total > m.limit)
        why.push(`It comes to ${money(p.total)} ("${p.raw}"), ${past} ${limit}.`);
    const extra = allowance(m.delivery, m.limit);
    const sum = addUp(r, t.products);
    if (sum.parts > 1 && sum.total > m.limit + extra)
      why.push(
        `It adds up to ${money(sum.total)} (${sum.raw}), ${past} ${limit}${extra ? ` and the ${money(extra)} the delivery terms allow on top` : ""}.`,
      );
  }

  const relative = relativeIn(text);
  if (relative.length)
    why.push(
      `It sets an amount by another one or leaves part of it open (${quoted(relative)}), so what it comes to can't be checked against the mandate.`,
    );
  if (r.found.length && SEVERAL_ITEMS.test(text))
    why.push(
      `It's about more than one item ("${SEVERAL_ITEMS.exec(text)?.[0]}"), and the mandate covers this listing only.`,
    );

  // The other side's price. A message that reads as agreeing agrees to it, so it must name the price it
  // agrees to: a number read from the seller's message is never trusted for a bare "Zgoda". While their
  // price is past the limit, or can't be read, nothing that reads as agreeing goes, and only a message
  // that names a price of ours inside the mandate goes at all, whatever its words.
  const theirs = theirPrice(n, f.seller);
  const pastTheirs = theirs === null || beyond(theirs);
  const sized = (v: number) => !beyond(v) && v >= priceFloor(m);
  const named = r.found.some((a) => a.values.some(sized));
  const offer = input.offer;
  const namesOffer =
    offer !== null &&
    sized(offer) &&
    r.found.some((a) => a.values.some((v) => Math.abs(v - offer) < 0.01));
  const agreeing =
    input.agree ||
    acceptance(text) !== null ||
    AGREES.test(text) ||
    AFFIRMATIVE_ONLY.test(text) ||
    (pastTheirs && AFFIRMATIVE_OPENING.test(text));
  if (agreeing && !namesOffer)
    why.push(
      "It reads as agreeing but doesn't name the price it agrees to, inside the mandate, in both the text and offer.",
    );
  if (pastTheirs) {
    const who = buying ? "seller" : "buyer";
    const said =
      theirs === null
        ? `the ${who}'s price can't be read from the conversation`
        : `the ${who}'s last price, ${money(theirs)}, is ${past} ${limit}`;
    if (agreeing) why.push(`It reads as agreeing, and ${said}.`);
    else if (!named)
      why.push(
        `It names no price of ours inside the mandate, and ${said}, so it could read as agreeing to it.`,
      );
  }

  // "Czy kopała kryptowaluty?" asks about the card, not how to pay.
  const talk = text.replace(MINING, " ");
  const foreign = [
    ...new Set(currenciesIn(talk).flatMap((c) => (c.code === m.currency ? [] : [`"${c.raw}"`]))),
  ];
  if (foreign.length)
    why.push(
      `It names another currency (${foreign.join(", ")}), and the mandate's amounts are in ${m.currency}.`,
    );

  // Paying and delivery: anything the terms don't allow asks, however our message words it.
  const terms = termsOf(m.delivery);
  for (const p of paymentsIn(talk))
    if (!terms.payments.has(p.name))
      why.push(
        `It brings up a way to pay that the mandate's terms don't name: ${p.name} ("${p.raw}").`,
      );
  const pickup = PICKUP.exec(inPerson(text))?.[0];
  if (pickup && !terms.pickup)
    why.push(
      `It brings up picking up or meeting in person ("${pickup}"), which the delivery terms ("${m.delivery}") don't allow.`,
    );
  const shipping = SHIPPING.exec(text)?.[0];
  if (shipping && !terms.shipping)
    why.push(
      `It brings up shipping ("${shipping}"), which the delivery terms ("${m.delivery}") don't include.`,
    );
  const paid = PAID.exec(text.replace(SENT_NOT_PAID, " "))?.[0];
  if (paid) why.push(`It says something was paid or sent ("${paid}").`);
  const contacts = contactsIn(text).filter((c) => !m.allow.includes(c.kind));
  for (const c of contacts) why.push(`It carries ${CONTACT_NAMES[c.kind]} ("${c.raw}").`);
  const links = linksIn(text);
  if (links.length) why.push(`It carries a link ("${links[0]?.slice(0, 80)}").`);
  return why;
}

const CONTACT_NAMES: Record<MandateContact, string> = {
  phone: "a phone number",
  email: "an e-mail address",
  address: "an address",
  apps: "another app",
};

// ——— Reading ———

/**
 * What a message can be written in and still be read: Latin letters with the Polish and Czech ones,
 * ASCII digits, ordinary punctuation, currency signs and plain spaces. Anything else (an emoji, a
 * combining mark, an invisible filler, a letter from another script, a look-alike digit) asks rather
 * than being mapped to what it might mean.
 */
const READABLE =
  /^[A-Za-z0-9ąćęłńóśźżĄĆĘŁŃÓŚŹŻáčďéěíňřšťúůýžÁČĎÉĚÍŇŘŠŤÚŮÝŽ .,!?:;'"’‘„”“«»()[\]\-–—/%+&@#*=_×°\p{Sc}]$/u;

/** The characters in a message, as it goes, that READABLE doesn't cover: shown, or as U+ codes. */
function unreadableChars(text: string): string[] {
  const odd = [...new Set(collapse(text))].filter((c) => !READABLE.test(c));
  return odd.map((c) => {
    const code = `U+${(c.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`;
    return /^[\p{L}\p{N}\p{P}\p{S}]$/u.test(c) && !/\p{Default_Ignorable_Code_Point}/u.test(c)
      ? `"${c}" ${code}`
      : code;
  });
}

/**
 * A seller's message can't be read for its price when a letter or digit in it is outside READABLE, or
 * anything else outside it stands in a word with digits: 1️⃣5️⃣0️⃣0️⃣, 1͏500, 15ОО. An emoji on its own is
 * fine.
 */
function oddNumbers(raw: string): boolean {
  const s = collapse(raw);
  if ([...s].some((c) => /[\p{L}\p{N}]/u.test(c) && !READABLE.test(c))) return true;
  return s.split(" ").some((w) => /\p{N}/u.test(w) && [...w].some((c) => !READABLE.test(c)));
}

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

/**
 * A message as the detectors read it: as the gate sends it (NFKC, no invisible format characters), with
 * combining marks, fillers and other invisible characters dropped, every script's digits as 0–9 and
 * ideographic full stops as dots.
 */
const clean = (text: string) =>
  collapse(text)
    .replace(/[\p{M}\p{Default_Ignorable_Code_Point}]/gu, "")
    // A braille blank shows as a space.
    .replace(/\u2800/g, " ")
    // Ideographic full stops, which a browser reads as dots in an address.
    .replace(/[\u3002\ufe12]/g, ".")
    .replace(/\p{Nd}/gu, (d) => (d >= "0" && d <= "9" ? d : String(digitValue(d))))
    .replace(/٫/g, ".")
    .replace(/٬/g, ",")
    .replace(/ {2,}/g, " ");

/** Latin, Cyrillic and Greek letters that pass for 0 and 1 inside a number: 15OO, l500. */
const LOOK_ALIKE = /(?<![\p{L}\p{N}])[\dOoОоΟοlIІіӀӏ]*\d[\dOoОоΟοlIІіӀӏ]*(?![\p{L}\p{N}])/gu;

/** A message as the policy reads it: clean, and O or l among a number's digits read as 0 or 1. */
export function plain(text: string): string {
  return clean(text).replace(LOOK_ALIKE, (w) =>
    w.replace(/[OoОоΟο]/g, "0").replace(/[lIІіӀӏ]/g, "1"),
  );
}

/**
 * Words with digits that can't be read as a number and a unit or a model's name: a look-alike letter
 * touching a digit (15OO, l500, 15OOzł, zł15OO), or letters between digits other than an x (1k5,
 * 15o0). Also look-alike letters alone where an amount goes: "IOOO zł", "Dam lOOO".
 */
function lookAlikes(s: string): string[] {
  const out: string[] = [];
  for (const m of s.matchAll(/[\p{L}\p{N}]+/gu)) {
    const w = m[0];
    if (/\d/.test(w)) {
      const segs = w.match(/\d+|\D+/g) ?? [];
      const odd = segs.some((seg, i) => {
        if (/^\d/.test(seg)) return false;
        const afterDigits = i > 0;
        const beforeDigits = i < segs.length - 1;
        if (afterDigits && beforeDigits) return seg.toLowerCase() !== "x";
        return (afterDigits && /^[OoIl]/.test(seg)) || (beforeDigits && /[OoIl]$/.test(seg));
      });
      if (odd) out.push(w);
    } else if (/^[OoIl]{2,}$/.test(w)) {
      const at = m.index ?? 0;
      const before = s.slice(0, at);
      const after = s.slice(at + w.length);
      if (
        CURRENCY.test(after) ||
        THOUSANDS.test(after) ||
        CURRENCY_BEFORE.test(before) ||
        priceWord(lastWord(before))
      )
        out.push(w);
    }
  }
  return out;
}

/** Letters written one by one, "B L I K", "W.h.a.t.s": every word check reads past them. */
const spelledOut = (text: string) =>
  [...clean(text).matchAll(/(?<![\p{L}\p{N}])\p{L}(?:[\s.\-*_]\p{L}){3,}(?![\p{L}\p{N}])/gu)].map(
    (m) => m[0],
  );

// ——— Agreeing ———

/**
 * Words that accept a price: biorę, zgoda, umowa, niech będzie, deal, I'll take it. Not right after
 * "nie": "nie kupię za tyle" refuses.
 */
const ACCEPT =
  /(?<![\p{L}])(?<!(?:^|[^\p{L}])nie\s+)(?:bior[eę]|wezm[eę]|kupuj[eę]|kupi[eę]|kupione|zgoda|zgadzam\s+si[eę]|zgadzamy\s+si[eę]|zgodz[eę]\s+si[eę]|umow[aęe]|umówi(?:eni|one|ona|ony)|umowi(?:eni|one|ona|ony)|niech\s+(?:\p{L}+\s+)?b[eę]dzie|akceptuj[eę]|przyjmuj[eę]|dobijamy|dobili[śs]my|dogadali[śs]my|dogadane|klepni[eę]te|zaklepane|wchodz[eę](?:\s+w\s+to)?|jestem\s+za(?=\s*(?:[.!,;]|$))|(?:dobra|ok|okej|umowa)\s*,?\s+stoi|(?<!(?:panu|pani|ci|wam|pa[ńn]stwu)\s+)pasuje(?=\s*(?:mi(?![\p{L}])|[.!,;]|$))|mi\s+pasuje|mo[żz]e\s+by[ćc](?=\s*(?:[.!,;]|$))|(?<=(?:^|[.!,;:]\s*|(?:it['’]?s|it\s+is|that['’]?s|that\s+is|got|ok(?:ay)?)\s+(?:a\s+)?))deal(?=\s*(?:[.!,;:]|$))|deal\s+at|agreed|i\s+agree|i\s+accept|accepted|(?:i(?:['’]ll|\s+will)|will)\s+(?:take|buy)\s+it)(?![\p{L}])/iu;

/**
 * Words that agree to the other side's price without being a plain yes: "za Pana cenę", "tyle, ile Pan
 * chce", "your asking price", "odpowiada mi", "idę na to". The accusative only: "Pana cena jest za
 * wysoka" refuses. They don't stop a message as ACCEPT does: they're checked like an agreement.
 */
const AGREES =
  /(?<![\p{L}])(?:mi\s+odpowiada|odpowiada\s+mi|id[ęe]\s+na\s+to|przystaj[ęe]|przekona[łl]\p{L}*\s+mnie|rezerwuj[ęe]|za[łl]atwione|mo[żz]e\s+by[ćc]\s+i\s+tak|czemu\s+nie|why\s+not|you\s+win|got\s+(?:yourself\s+)?a\s+deal|i(?:['’]ll|\s+will)\s+(?:buy|take\s+(?:the|this|that|your))|works\s+for\s+me|let['’]?s\s+do\s+it|count\s+me\s+in|sold|(?:pana|pani|your)\s+(?:warunki|terms)|cena\s+jest\s+w\s+porz[ąa]dku|price\s+is\s+(?:fine|ok|okay|good|right)|(?:pana|pani|pa[ńn]sk\p{L}*|pa[ńn]stwa|tw[oó]j\p{L}*|tw[aą])\s+(?:cen[eę]|propozycj[eę]|ofert[eę]|kwot[eę])|tyle\s*,?\s+(?:ile|co)|ile\s+(?:pan|pani|pa[ńn]stwo)\s+\p{L}+|(?:pay|take|accept|meet|at|for)\s+your\s+(?:asking\s+)?(?:price|offer)|what\s+you(?:['’]re|\s+are)?\s+ask\p{L}*|asking\s+price|full\s+price|pe[łl]n[aąe]\s+cen[eęy]|cen[eęy]\s+(?:wywo[łl]awcz\p{L}*|z\s+og[łl]oszenia|katalogow\p{L}*))(?![\p{L}])/iu;

/** A message of nothing but yes: "Ok.", "Tak!", "Dobrze, poproszę", "Sure, sounds good". */
const AFFIRMATIVE_ONLY =
  /^[\s.,!…-]*(?:(?:ok(?:ay|ej|i)?|tak|dobrze|dobra|jasne|pewnie|spoko|super|[śs]wietnie|git|zgoda|fine|sure|yes|yeah|yep|great|perfect|alright|cool|deal|sold|w\s+porz[ąa]dku|no\s+to|to|poprosz[ęe]|please|sounds\s+good|that\s+works|w\s+takim\s+razie|then)[\s.,!…-]*)+$/iu;
/** A message that opens with yes: after a price past the limit, it reads as taking it. */
const AFFIRMATIVE_OPENING =
  /^\s*(?:ok(?:ay|ej|i)?|tak|dobrze|dobra|jasne|pewnie|spoko|super|[śs]wietnie|git|zgoda|fine|sure|yes|yeah|yep|great|perfect|alright|all\s+right|cool|sold|deal|w\s+porz[ąa]dku|czemu\s+nie|why\s+not)(?![\p{L}])/iu;
/** The least that's a price rather than a fee or a count: half the opening offer, or of the limit. */
const priceFloor = (m: Negotiation["mandate"]) => Math.min(m.opening, m.limit) / 2;

/** The words in a message that accept a price, if any. */
export function acceptance(raw: string): string | null {
  return ACCEPT.exec(plain(raw))?.[0] ?? null;
}

/**
 * The seller's price as the conversation shows it: the most they named since our last message (the
 * least, when we sell), else the latest price they named, else the asking price. Null when it can't be
 * read for certain: in words, digit by digit, per item, in another currency, or with characters that
 * aren't plain digits in a number.
 */
function theirPrice(n: Negotiation, seller: SendFacts["seller"]): number | null {
  const worst = (xs: number[]) => (n.role === "buy" ? Math.max(...xs) : Math.min(...xs));
  const reading = (raw: string) => {
    const r = read(raw, n.title, n.asking);
    const t = combine(r);
    const text = plain(raw);
    return {
      // A price, not a shipping fee, a time or "o 100 zł". "Cena bez zmian" is the asking price.
      values: [
        ...r.found.flatMap((a) => a.values),
        ...t.sums.map((x) => x.total),
        ...t.products.map((x) => x.total),
        ...(FIRM.test(text) && n.asking !== null ? [n.asking] : []),
      ].filter((v) => v >= priceFloor(n.mandate)),
      unclear:
        relativeIn(text).length > 0 ||
        SEVERAL_ITEMS.test(text) ||
        t.each.length > 0 ||
        r.unclear.length > 0 ||
        oddNumbers(raw) ||
        numberWords(raw).length > 0 ||
        currenciesIn(raw).some((c) => c.code !== n.mandate.currency),
    };
  };
  const recent = seller.filter((s) => s.after).map((s) => reading(s.text));
  if (recent.some((r) => r.unclear)) return null;
  const named = recent.flatMap((r) => r.values);
  if (named.length) return worst(named);
  for (const s of seller.toReversed()) {
    const r = reading(s.text);
    if (r.unclear) return null;
    if (r.values.length) return worst(r.values);
  }
  return n.asking;
}

/** A seller holding to the listing's price without naming it: "cena bez zmian", "price as listed". */
const FIRM =
  /(?<![\p{L}])(?:cen\p{L}*\s+(?:jak\s+w\s+og[łl]oszeniu|z\s+og[łl]oszenia|bez\s+zmian|ostateczn\p{L}*|sztywn\p{L}*|nie\s+podlega\p{L}*|aktualn\p{L}*)|nie\s+negocjuj\p{L}*|bez\s+negocjacji|nie\s+zejd[ęe]|nie\s+opuszcz\p{L}*|price\s+(?:as\s+listed|stays|is\s+firm|is\s+final|is\s+fixed)|asking\s+price|full\s+price|not\s+negotiable|no\s+negotiation)(?![\p{L}])/iu;

/** More than one item: the mandate is for this listing, one item, at one price. */
const SEVERAL_ITEMS =
  /(?<![\p{L}])(?:obie|oba|obydw\p{L}*|both|w\s+parze|tylko\s+razem|as\s+a\s+pair|(?:wszystkie|all)\s+(?:trzy|cztery|three|four|of\s+them|karty|sztuki|cards)|drug[aąi]\s+(?:kart\p{L}*|sztuk\p{L}*|egzemplarz\p{L}*)|second\s+(?:card|one|item))(?![\p{L}])/iu;

/** Words that make a payment go with something more, without an amount: the rest, the difference. */
const REMAINDER =
  /(?<![\p{L}])(?:reszt[aęy]|r[óo][żz]nic[aęy]|brakuj[ąa]c\p{L}*\s+kwot\p{L}*|the\s+(?:rest|difference|remainder|balance))(?![\p{L}])/iu;
const PAY_VERB =
  /(?<![\p{L}])(?:dop[łl]ac\p{L}*|dop[łl]at\p{L}*|zap[łl]ac\p{L}*|p[łl]ac\p{L}*|oddam|odda[ćc]|dam|dorzuc\p{L}*|przelej\p{L}*|przela\p{L}*|wy[śs]l[ęe]|pay\p{L}*|send)(?![\p{L}])/iu;
/** Amounts set by another one: 50%, 23% VAT, o 100 zł, 500 więcej, 2 x tyle, pół ceny, do Pana ceny. */
const RELATIVE: RegExp[] = [
  // Any share but 100%, which is a manner of speaking ("sprawna w 100%").
  /(?<![\d.,])(?!100(?![\d.,]))\d+(?:[.,]\d+)?\s?(?:%|procent\p{L}*|percent)/giu,
  /(?<![\p{L}])(?:netto|(?:\+|plus)\s*vat)(?![\p{L}])/giu,
  /\d+(?:[.,]\d+)?\s*(?:zł|zl|pln|złotych)?\s+(?:wi[ęe]cej|mniej|taniej|dro[żz]ej|extra|more|less|cheaper|off)(?![\p{L}])/giu,
  /(?<![\p{L}])(?:zej[śs][ćc]|zejd\p{L}*|opu[śs]ci\p{L}*|opuszcz\p{L}*|obni[żz]\p{L}*|podnie[śs]\p{L}*|podnios\p{L}*|podbi\p{L}*|zwi[ęe]ksz\p{L}*|spu[śs]ci\p{L}*|dorzuc\p{L}*|do[łl]o[żz]\p{L}*)\s+(?:o\s+)?\d+/giu,
  /(?<![\p{L}])(?:(?:\d+|dwa|trzy|two|three)\s*(?:x|×|razy|times)\s+(?:tyle|that|as\s+much)|podw[óo]jnie|potr[óo]jnie|pay\s+double|double\s+(?:the|your|that|it|what)|triple\s+(?:the|your|that|it)|o\s+po[łl]ow[ęe]|(?:p[óo][łl]|po[łl]ow[ęe]|po[łl]owa)\s+ceny|half\s+(?:the\s+)?price|half\s+of\s+(?:the|your|what))(?![\p{L}])/giu,
  /(?<![\p{L}])(?:(?:do|ponad|od)\s+(?:pana|pani|pa[ńn]sk\p{L}*|twoj\p{L}*|pa[ńn]stwa)\s+cen\p{L}*|(?:on\s+top\s+of|over|above|more\s+than)\s+(?:your|the)\s+(?:asking\s+)?price|(?:pana|pani|your)\s+(?:cen\p{L}*|price)\s+(?:plus|\+))(?![\p{L}])/giu,
  /(?<![\p{L}])(?:(?:to|tyle)\s+samo\s+(?:za|jeszcze)|za\s+tyle\s+samo|the\s+same\s+(?:again|for|amount))(?![\p{L}])/giu,
  /(?<![\p{L}])(?:miesi[ęe]cznie|co\s+miesi[ąa]c|monthly|per\s+month|tygodniowo|co\s+tydzie[ńn]|weekly|na\s+raty|w\s+ratach|installments?)(?![\p{L}])/giu,
];

/** Amounts that depend on another or leave part of the total open: they can't be checked. */
function relativeIn(text: string): string[] {
  const out = RELATIVE.flatMap((re) => [...text.matchAll(re)].map((m) => m[0]));
  const rest = REMAINDER.exec(text)?.[0];
  if (rest && PAY_VERB.test(text)) out.push(rest);
  return out;
}

// ——— Amounts ———

/** Currencies by code: the words (regex) and signs they're written with. */
const MONEY: { code: string; words: string; signs?: string }[] = [
  { code: "PLN", words: "zł|zl|złot\\p{L}*|zlot\\p{L}*|złocisz\\p{L}*|zlocisz\\p{L}*|pln|zeta" },
  // Grosze are hundredths: 150000 groszy is 1,500 zł, so they can't be read at face value either.
  { code: "grosze", words: "grosz\\p{L}*" },
  // Euro RTV AGD is a shop, where receipts come from.
  {
    code: "EUR",
    words:
      "eur|euro(?!\\s*(?:rtv|agd|net))|euros\\p{L}*|euras\\p{L}*|eurak\\p{L}*|ojro|jewr\\p{L}*|ejro|e[łl]ro|евро",
    signs: "€",
  },
  {
    code: "USD",
    words: "usd|dolar\\p{L}*|dollar\\p{L}*|dolc\\p{L}*|dolec|baks\\p{L}*|bucks?",
    signs: "\\$",
  },
  {
    code: "GBP",
    words: "gbp|funt\\p{L}*|funciak\\p{L}*|pounds?|quid|sterling\\p{L}*|szterling\\p{L}*",
    signs: "£",
  },
  { code: "CZK", words: "czk|kč|korun\\p{L}*" },
  { code: "CHF", words: "chf|frank(?:i|a|ów|ach|ami)?|francs?" },
  { code: "UAH", words: "uah|hrywn\\p{L}*|hrywien", signs: "₴" },
  { code: "HUF", words: "huf|forint\\p{L}*" },
  { code: "RUB", words: "rubl\\p{L}*|rubel", signs: "₽" },
  { code: "JPY", words: "jpy", signs: "¥" },
  { code: "BTC", words: "btc|bitcoin\\p{L}*", signs: "₿" },
  { code: "ETH", words: "eth|ethereum" },
  { code: "USDT", words: "usdt|tether" },
];
/** Words that are money only right after a number: 300 zielonych, 300 kr, 300 Ft, 300 lei, 300 koron. */
const MONEY_AFTER: { code: string; words: string }[] = [
  { code: "USD", words: "zielon\\p{L}*" },
  { code: "CZK", words: "koron\\p{L}*" },
  { code: "kr", words: "kr" },
  { code: "HUF", words: "ft" },
  { code: "RON", words: "lei|lej" },
  { code: "CHF", words: "fr" },
];
/**
 * ISO 4217 codes in capitals: anywhere for these, which no word or model name is spelt like (sek is
 * seconds in Polish, AMD a maker of graphics cards), and right after a number for any other: 300 TRY.
 */
const ANYWHERE = "SEK NOK DKK ISK RON BGN CAD AUD NZD CNY INR TRY ILS AED MXN BRL ZAR".split(" ");
const CODES = new RegExp(`(?<![\\p{L}])(?:${ANYWHERE.join("|")})(?![\\p{L}])`, "gu");
const ISO = new Set(Intl.supportedValuesOf("currency"));
const moneyWords = MONEY.map((c) => c.words).join("|");
const moneySigns = MONEY.flatMap((c) => (c.signs ? [c.signs] : [])).join("|");
/** Currency next to a number: it's money, whatever else it looks like. */
const CURRENCY = new RegExp(`^\\s?(?:(?:${moneyWords})(?![\\p{L}])|${moneySigns})`, "iu");
const CURRENCY_BEFORE = new RegExp(`(?:(?<![\\p{L}])(?:${moneyWords})|${moneySigns})\\s?$`, "iu");

/** Currencies a message names, by code, with the amount next to each when there is one. */
export function currenciesIn(text: string): { code: string; raw: string }[] {
  const s = plain(text);
  const out: { code: string; raw: string }[] = [];
  const near = (at: number, word: string) => {
    const before = /\d+(?:[.,' ]\d+)*\s?$/.exec(s.slice(0, at))?.[0] ?? "";
    const after = before ? "" : (/^\s?\d+(?:[.,']\d+)*/.exec(s.slice(at + word.length))?.[0] ?? "");
    return `${before}${word}${after}`.trim();
  };
  for (const c of MONEY) {
    const re = new RegExp(
      `(?<![\\p{L}])(?:${c.words})(?![\\p{L}])${c.signs ? `|${c.signs}` : ""}`,
      "giu",
    );
    for (const m of s.matchAll(re)) out.push({ code: c.code, raw: near(m.index ?? 0, m[0]) });
  }
  for (const c of MONEY_AFTER)
    for (const m of s.matchAll(new RegExp(`\\d\\s?((?:${c.words})(?![\\p{L}]))`, "giu")))
      out.push({
        code: c.code,
        raw: near((m.index ?? 0) + m[0].length - (m[1]?.length ?? 0), m[1] ?? ""),
      });
  for (const m of s.matchAll(CODES)) out.push({ code: m[0], raw: near(m.index ?? 0, m[0]) });
  for (const m of s.matchAll(/\d\s?([A-Z]{3})(?![\p{L}])/gu)) {
    const code = m[1] ?? "";
    if (ISO.has(code) && !MONEY.some((c) => c.code === code) && !ANYWHERE.includes(code))
      out.push({ code, raw: near((m.index ?? 0) + m[0].length - code.length, code) });
  }
  // Any other currency sign: ₺, ₹, ₩.
  const known = new RegExp(moneySigns, "u");
  for (const m of s.matchAll(/\p{Sc}/gu))
    if (!known.test(m[0])) out.push({ code: m[0], raw: near(m.index ?? 0, m[0]) });
  return out;
}

/** Thousands after a number: 1,4k, 1.5 tys., 2 grand, 2 koła, 3 kafle, 1,5 kawałka. */
const THOUSANDS =
  /^\s?(?:k|tys\.?|tyś\.?|ty[śs]k\p{L}*|tysi\p{L}*|tysiak\p{L}*|thousands?|grand|kawa[łl]\p{L}*|kafl\p{L}*|kafel|patyk\p{L}*|patol\p{L}*|ko[łl][ao]|k[óo][łl])(?![\p{L}])/iu;
/** Hundreds after a number: 15 stów, 14 stówek, 12 setek, fourteen hundred. */
const HUNDREDS =
  /^\s?(?:st[óo]w\p{L}*|stow[aeky]\p{L}*|setk\p{L}*|setek|stuz[łl]ot[óo]w\p{L}*|hundreds?)(?![\p{L}])/iu;
/** Five hundreds after a number: 3 pięćsetki. */
const FIVE_HUNDREDS =
  /^\s?(?:pi[ęe][ćc]setk\p{L}*|pi[ęe][ćc]setek|pi[ęe][ćc]setz[łl]ot\p{L}*)(?![\p{L}])/iu;
/** Millions after a number: 1,5 bańki, 2 mln, 1kk. */
const MILLIONS =
  /^\s?(?:kk|mln|mio|milion\p{L}*|million\p{L}*|ba[ńn]k\p{L}*|ba[ńn]i[ae]?|baniek)(?![\p{L}])/iu;
/** Each scale a number can be followed by, and what it multiplies by. */
const SCALES: [RegExp, number][] = [
  [MILLIONS, 1_000_000],
  [THOUSANDS, 1000],
  [FIVE_HUNDREDS, 500],
  [HUNDREDS, 100],
];

/**
 * What a number counts when this word follows it: not money. No one-letter units: "2000 w gotówce" is
 * money, not watts.
 */
const UNIT =
  /^\s?(?:%|procent\p{L}*|gb|tb|mb|kb|mhz|ghz|hz|mah|wh|cm|mm|km|kg|ml|cali|cale|cal|szt\.?|sztuk\p{L}*|dni|dzień|dnia|godz\.?|godzin\p{L}*|minut\p{L}*|sek\.?|tyg\.?|tygodni\p{L}*|mies\.?|miesi\p{L}*|rok|roku|lat|lata|h|fps|rpm|gen\.?|generacji|rdzeni\p{L}*|bit|bitów|days?|hours?|weeks?|months?|years?|pcs|pieces?|inch\p{L}*)(?![\p{L}\p{N}])/iu;
/** A model's letters glued after its number: 3070ti, 6700xt, 2x8GB, 2nd. Anything else glued on asks. */
const MODEL_SUFFIX = /^(?:ti|xt|xtx|super|x(?=\d)|st|nd|rd|th|nm)(?![\p{L}])/iu;
/** A unit or a model's letters after a number: 8 GB, 3070ti, 5600X. */
const unitAfter = (after: string) =>
  UNIT.test(after) || MODEL_SUFFIX.test(after) || /^(?:X|XT|XTX|X3D)(?!\p{L})/u.test(after);
/** A year after these words. Not w, z, od, in or from on their own: "w 2000" is as likely money. */
const YEAR_BEFORE =
  /(?:^|[^\p{L}])(?:rok|roku|rocznik|since|year|(?:gwarancj\p{L}*|warranty)\s+(?:do|until|till|to)|stycz\p{L}*|lut\p{L}*|marc\p{L}*|marzec|kwie\p{L}*|maj[a]?|czerw\p{L}*|lip\p{L}*|sierp\p{L}*|wrze[śs]\p{L}*|pa[źz]dziernik\p{L}*|listopad\p{L}*|grud\p{L}*|january|february|march|april|may|june|july|august|september|october|november|december)\s$/iu;
const YEAR_AFTER = /^\s?(?:r\.|r(?![\p{L}])|rok|roku)/iu;

/**
 * Dates and times, blanked before numbers are read: their digits aren't amounts or phone numbers. A
 * short year only with a two-digit day and month: 1.5.00 is a number written oddly, not a date.
 */
const blankDates = (text: string) =>
  text
    .replace(
      /(?<![\d.,])(?:\d{1,2}([./-])\d{1,2}\1(?:19|20)\d{2}|\d{2}([./-])\d{2}\2\d{2})(?![\d.,]?\d)/g,
      (x) => " ".repeat(x.length),
    )
    .replace(/(?<!\d)\d{1,2}:\d{2}(?!\d)/g, (x) => " ".repeat(x.length));

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
 * (RTX3070, 16GB, i7-12700), a model number after the word it follows in the title (RTX 3070), units
 * (8 GB, 3 dni), times, dates, phone numbers and likely years. A model number stays an amount when it's
 * the asking price or follows a price word ("cena 1500"). Each separator is read every way it could be
 * (1.500 is 1500 or 1.5), so the cap can't be dodged by the format.
 */
export function amountsIn(text: string, title: string, asking: number | null = null): Amount[] {
  return read(text, title, asking).found.map(({ raw, values }) => ({ raw, values }));
}

/** An amount and where it stands in the text it was read from. */
type Found = Amount & { index: number; end: number; money: boolean };
/** A number that can't be read for certain; spaced when it's digits written one by one. */
type Unclear = { raw: string; spaced: boolean };
type Reading = { s: string; found: Found[]; unclear: Unclear[] };

/** A phone number as written, nine digits with an optional +48, so it isn't read as amounts. */
const PHONE_SHAPE =
  /^(?:(?:\+|00)?48[\s-]?)?(?:\d{9}|\d{3}([\s.-])\d{3}\1\d{3}|\d{2}([\s.-])\d{3}\2\d{2}\2\d{2})$/;

/**
 * The amounts in `text`, where they stand in `s`: the text as read, dates and phone numbers blanked;
 * and the numbers that can't be read for certain.
 */
function read(text: string, title: string, asking: number | null): Reading {
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
  const pre = clean(text);
  const unclear: Unclear[] = lookAlikes(pre).map((raw) => ({ raw, spaced: false }));
  let s = blankDates(plain(text));
  for (const p of phonesIn(s)) {
    const at = s.indexOf(p);
    if (PHONE_SHAPE.test(p.trim()) && !priceWord(lastWord(s.slice(0, at))))
      s = s.replace(p, " ".repeat(p.length));
  }

  const out: Found[] = [];
  /** One number at `index`: an amount unless something around it says it isn't. */
  const judge = (raw: string, index: number, values: number[], parts: number) => {
    const before = s.slice(0, index);
    const after = s.slice(index + raw.length);
    const money = CURRENCY.test(after) || CURRENCY_BEFORE.test(before);
    // The asking price is a price wherever it stands, even after a model's name.
    const asked = asking !== null && values.includes(asking);
    if (!money && !asked) {
      // RTX3070, iPhone12, i7, b550: glued to a model's letters, unless they're a price word (za1500)
      // or say "about" (ok450, CA450).
      const glued = /\p{L}+$/u.exec(before)?.[0];
      if (
        glued &&
        !priceWord(glued) &&
        !/^(?:ok|ca)$/i.test(glued) &&
        !priceWord(lastWord(before.slice(0, -glued.length))) &&
        (modelLike(glued) ||
          models.has(`${glued.toLowerCase()} ${raw}`) ||
          (glued.length === 1 && values.every((v) => v < 1000)))
      )
        return;
      // i7-12700, RX-580: after a hyphen glued to a model's letters. Not "oferta-1500" or "PLN-1500".
      const hyphened = /(?<![\p{L}\p{N}])(\p{L}[\p{L}\p{N}]*)-$/u.exec(before)?.[1];
      if (
        hyphened &&
        !priceWord(hyphened) &&
        (modelLike(hyphened) || /\d/.test(hyphened)) &&
        !CURRENCY_BEFORE.test(hyphened)
      )
        return;
    }
    const scaling = SCALES.find(([re]) => re.test(after));
    const scaled = scaling ? (scaling[0].exec(after)?.[0] ?? null) : null;
    const scale = scaling?.[1] ?? 1;
    // 4K: a resolution, "w 4K", "4K gaming".
    if (
      scale === 1000 &&
      /^[248]$/.test(raw) &&
      /^K/.test(after) &&
      (/(?:^|[^\p{L}])(?:w|in)\s$/iu.test(before) ||
        /^K\s*(?:gaming|ultra|hdr|monitor|tv|@|60|120|144)/iu.test(after))
    )
      return;
    if (!money && scaled === null) {
      if (unitAfter(after)) return;
      // 1080p: a resolution.
      if (/^p(?![\p{L}])/u.test(after) && /^(?:480|720|1080|1440|2160)$/.test(raw)) return;
      const word = /(\p{L}+)[\s-]$/u.exec(before)?.[1];
      // Only with the title's word before it: the title's number on its own ("Mogę 6800") is a price.
      if (word && !asked && !priceWord(word) && models.has(`${word.toLowerCase()} ${raw}`)) return;
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
      // 1500i, 1.5kzł, 650W: letters glued on that aren't a unit, a currency or a model's: an amount,
      // and one that can't be read for certain. Not 3D or 3x, too small to matter.
      const glued = /^\p{L}+/u.exec(after)?.[0];
      if (glued && values.some((v) => v >= 10)) unclear.push({ raw: raw + glued, spaced: false });
    }
    // "Mogę 1,5": a price in thousands without the k. Not "9,99 zł" or "1,5 tys.", which say what they are.
    const thousandsToo = !money && scaled === null && /^\d[.,]\d$/.test(raw);
    out.push({
      raw: raw + (scaled ?? ""),
      values: [...values, ...(thousandsToo ? values.map((v) => v * 1000) : [])].map(
        (v) => Math.round(v * scale * 100) / 100,
      ),
      index,
      end: index + raw.length + (scaled?.length ?? 0),
      money,
    });
  };

  // Digit groups with one character between: 1 400, 1.400,50, 1100+400, 15 00, 1–5–0–0. A space
  // before a number with a unit, or after the title's model number, ends one: RTX 3070 8 GB, 2 dni.
  const runs: { run: string; at: number }[] = [];
  for (const m of s.matchAll(/\d+(?:[^\p{L}\p{N}]\d+)*/gu)) {
    const at = m.index ?? 0;
    let start = 0;
    for (const sp of m[0].matchAll(/(\d+) (?=(\d+))/g)) {
      const cut = (sp.index ?? 0) + (sp[1]?.length ?? 0);
      const next = s.slice(at + cut + 1 + (sp[2]?.length ?? 0));
      const word = /(\p{L}+)[\s-]$/u.exec(s.slice(0, at + (sp.index ?? 0)))?.[1];
      if (unitAfter(next) || (word && models.has(`${word.toLowerCase()} ${sp[1]}`))) {
        runs.push({ run: m[0].slice(start, cut), at: at + start });
        start = cut + 1;
      }
    }
    runs.push({ run: m[0].slice(start), at: at + start });
  }
  for (const { run, at } of runs) {
    // The parts a number's own separators join; between them, 1100+400 or 10/5 are separate numbers.
    const parts = [...run.matchAll(/\d+(?:[ .,'’]\d+)*/g)];
    const joins = run
      .replace(/\d+(?:[ .,'’]\d+)*/g, "\0")
      .split("\0")
      .slice(1, -1);
    let odd = joins.some((c) => !/^[/\-–—+×*=]$/.test(c));
    for (const p of parts) {
      const raw = p[0];
      const index = at + (p.index ?? 0);
      const groups = raw.split(/[ .,'’]/);
      const values = readings(groups, raw.match(/[ .,'’]/g) ?? []);
      if (values.length) {
        judge(raw, index, values, groups.length);
        continue;
      }
      // 15 00, 1.5.00, 1400,1300: no one number. Each part is judged where it stands, and it asks.
      odd = true;
      let k = index;
      for (const g of groups) {
        const i = s.indexOf(g, k);
        judge(g, i, [Number(g)], 1);
        k = i + g.length;
      }
    }
    const digits = run.split(/\D/);
    const spaced = digits.length >= 3 && digits.filter((g) => g.length === 1).length >= 2;
    if (spaced || odd) unclear.push({ raw: run, spaced });
  }
  return { s, found: out, unclear };
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

/** Between two of the seller's amounts, makes them one sum: 1100+400, 1100 i 400 przy odbiorze. */
const JOIN =
  /\+|(?<![\p{L}])(?:plus|i|oraz|dorzuc\p{L}*|do[łl]o[żz]\p{L}*|dop[łl]ac\p{L}*|do\s+tego|ponadto|jeszcze|and|extra|on\s+top)(?![\p{L}])/iu;
/** Between two amounts, keeps them apart: they're alternatives, not a sum. */
const APART = /(?<![\p{L}])(?:albo|lub|czy|or|zamiast|instead|nie|not)(?![\p{L}])/iu;
/** A number times another: 2 x 750, 2×750, 2 razy po 750, 2 sztuki po 750, 750 zł x 2. */
const MULTIPLY =
  /(?<![\d.,])(\d+(?:[.,]\d+)*)\s*(?:(?:zł|zl|pln|złotych)\.?\s*)?(?:x|×|\*|razy(?:\s+po)?|times|szt\.?(?:\s+po)?|sztuk\p{L}*(?:\s+po)?|pcs\.?|pieces?)\s*(?:po\s+|à\s*|@\s*)?(\d+(?:[.,]\d+)*)/giu;
/** After an amount: it's the price of each item, so the total depends on how many. */
const EACH =
  /^\s?(?:(?:zł|zl|pln|złotych)\.?\s?)?(?:za\s+(?:1\s*)?(?:sztuk[eęi]|szt\.?|każd\p{L}*|jedn\p{L}*|egzemplarz\p{L}*|egz\.?)|od\s+(?:sztuki|egzemplarza|karty)|\/\s?1?\s?(?:szt\.?|sztuk[aęi])|każd[aey]|each|apiece|a\s+piece|(?:per|for)\s+(?:item|piece|unit|one|each|card))(?![\p{L}])/iu;
/** After an amount, when the message counts items: "1000 zł za kartę" is then a price each. */
const EACH_IF_COUNTED =
  /^\s?(?:(?:zł|zl|pln|złotych)\.?\s?)?(?:za|per|for\s+(?:the|a|each))\s+(?:kart\p{L}*|cards?|sztuk\p{L}*)/iu;

/** More than one item, so "po 750" is a price each. */
const SEVERAL =
  /(?<![\p{L}])(?:obie|oba|obydw\p{L}*|dwie|dwa|trzy|cztery|kilka|wszystk\p{L}*|both|two|three|four|several|all|pair|parze)(?![\p{L}])/iu;
/** A count of items in digits: "3, po 500", "2 raty", "3 szt.". */
const COUNT =
  /(?<![\d.,])[2-9]\d?\s*(?:,|szt\p{L}*|sztuk\p{L}*|rat\p{L}*|egz\p{L}*|pcs|pieces?|items?|x(?![\p{L}]))/iu;

/** Amounts in one message that make one total: added up, multiplied, or a price for each of several. */
type Spanned = { raw: string; total: number; index: number; end: number };

/** What the amounts in a message come to together: sums across JOIN words, products, prices each. */
function combine(r: Reading): { sums: Spanned[]; products: Spanned[]; each: Spanned[] } {
  const { s, found } = r;
  const most = (a: Amount) => Math.max(...a.values);
  const quote = (from: number, to: number) => s.slice(from, to).replace(/\s+/g, " ").trim();
  const sums: Spanned[] = [];
  let group: Found[] = [];
  const flush = () => {
    const first = group[0];
    const last = group.at(-1);
    if (group.length > 1 && first && last)
      sums.push({
        raw: quote(first.index, last.end).slice(0, 80),
        total: group.reduce((sum, a) => sum + most(a), 0),
        index: first.index,
        end: last.end,
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

  const products: Spanned[] = [];
  for (const m of s.matchAll(MULTIPLY)) {
    const index = m.index ?? 0;
    const after = s.slice(index + m[0].length);
    const thousands = THOUSANDS.test(after);
    // 30x40 cm, 2x8GB: sizes and parts, not money. RTX 3070 x 2: a model, twice.
    if (!thousands && (UNIT.test(after) || (/^\p{L}/u.test(after) && !CURRENCY.test(after))))
      continue;
    const model = /(\p{L}+)[\s-]?$/u.exec(s.slice(0, index))?.[1];
    if (model && modelLike(model) && !priceWord(model)) continue;
    const factor = (x: string) => {
      const groups = x.split(/[.,]/);
      return Math.max(
        Number(x.replace(",", ".")) || 0,
        ...readings(groups, x.match(/[.,]/g) ?? []),
      );
    };
    products.push({
      raw: m[0],
      total: factor(m[1] ?? "0") * factor(m[2] ?? "0") * (thousands ? 1000 : 1),
      index,
      end: index + m[0].length,
    });
  }

  // "po 750" is a price each when it's money or the message counts items: "3, po 500", "obie po 700".
  // Not "podjadę po 17".
  const counts = SEVERAL.test(s) || COUNT.test(s);
  const each: Spanned[] = [];
  for (const a of found)
    if (
      EACH.test(s.slice(a.end)) ||
      (counts && EACH_IF_COUNTED.test(s.slice(a.end))) ||
      (/(?<![\p{L}])(?:po|każd[aey]\s+(?:za|po)|each(?:\s+one)?(?:\s+(?:for|at))?)\s$/iu.test(
        s.slice(0, a.index),
      ) &&
        (a.money || counts))
    )
      each.push({
        raw: quote(a.index, a.end),
        total: most(a),
        index: a.index,
        end: a.end,
      });
  return { sums, products, each };
}

/**
 * Every amount in our message added up, each product counted once as what it comes to: whatever words
 * stand between them, they may be one total to the seller.
 */
function addUp(r: Reading, products: Spanned[]): { total: number; parts: number; raw: string } {
  const terms = [
    ...r.found
      .filter((a) => !products.some((p) => a.index >= p.index && a.index < p.end))
      .map((a) => ({ raw: a.raw, total: Math.max(...a.values) })),
    ...products,
  ];
  return {
    total: Math.round(terms.reduce((sum, t) => sum + t.total, 0) * 100) / 100,
    parts: terms.length,
    raw: terms
      .map((t) => `"${t.raw}"`)
      .join(" + ")
      .slice(0, 120),
  };
}

/** The delivery terms' clauses: split at , ; ( ) and full stops, dashes and "but". */
const clauses = (terms: string) =>
  terms.split(
    /[,;()\n]|\.(?=\s+\p{Lu}|\s*$)|\s[-–—]\s|(?<![\p{L}])(?:but|ale|lecz|however)(?![\p{L}])/u,
  );
/**
 * A clause that rules something out. Its words aren't read for what they rule out: whatever the clause
 * names counts as not allowed.
 */
const NEGATIVE =
  /(?<![\p{L}])(?:no|not|never|none|nor|avoid\p{L}*|except|without|exclud\p{L}*|forbidden|prohibited|disallowed|unavailable|impossible|cannot|can['’]?t|don['’]?t|doesn['’]?t|won['’]?t|isn['’]?t|aren['’]?t|bez|nie\p{L}*|nigdy|brak\p{L}*|zakaz\p{L}*|opr[óo]cz|wyj[ąa]tk\p{L}*|wyklucz\p{L}*|zabronion\p{L}*|unika\p{L}*)(?![\p{L}])/iu;

/** What the mandate's delivery terms allow: only what a clause names without ruling anything out. */
function termsOf(delivery: string): { payments: Set<string>; pickup: boolean; shipping: boolean } {
  const yes = clauses(delivery).filter((c) => !NEGATIVE.test(c));
  return {
    payments: new Set(yes.flatMap((c) => paymentsIn(c).map((p) => p.name))),
    pickup: yes.some((c) => PICKUP.test(plain(c))),
    shipping: yes.some((c) => SHIPPING.test(plain(c))),
  };
}

/** A clause that puts an amount on top of the price: "up to 20 zł on top", "dopłata za wysyłkę". */
const ON_TOP =
  /on\s+top|extra|additional|dodatkow\p{L}*|ponad|dop[łl]at\p{L}*|(?:for|za|na)\s+(?:the\s+)?(?:shipping|postage|delivery|wysy[łl]k\p{L}*|przesy[łl]k\p{L}*|dostaw\p{L}*|kurier\p{L}*|paczkomat\p{L}*)/iu;
/** A clause whose amount is a total, a cap or a value, not something on top. */
const NOT_ON_TOP =
  /total|in\s+all|altogether|overall|includ\p{L}*|incl|w\s+tym|[łl][ąa]cznie|razem|z\s+wysy[łl]k[ąa]|insur\p{L}*|ubezpiecz\p{L}*|warto[śs]\p{L}*|value|protect\p{L}*|ochron\p{L}*|limit|maks\p{L}*|max\p{L}*|ceiling/iu;

/**
 * Shipping on top of the price that the mandate's delivery terms allow: an amount in a clause that puts
 * it on top ("OLX delivery, up to 20 zł on top"), never more than a tenth of the limit.
 */
export function allowance(delivery: string, limit: number): number {
  let most = 0;
  for (const c of clauses(delivery)) {
    if (!ON_TOP.test(c) || NOT_ON_TOP.test(c)) continue;
    for (const a of read(c, "", null).found) if (a.money) most = Math.max(most, ...a.values);
  }
  return Math.min(most, Math.floor(limit / 10));
}

// ——— Amounts in words ———

/** Numerals from 0 to 9, a half and a few: counts, harmless alone ("dwa wentylatory"). */
const SMALL =
  /^(?:zero|jeden|jedna|jedno|jednego|jednej|jednym|jedn[ąa]|jednemu|dwa|dwie|dw[óo]ch|dwom|dwoma|dwiema|trzy|trzech|trzem|trzema|cztery|czterech|czterem|czterema|pi[ęe][ćc]|pi[ęe]ciu|sze[śs][ćc]|sze[śs]ciu|siedem|siedmiu|osiem|o[śs]miu|dziewi[ęe][ćc]|dziewi[ęe]ciu|p[óo][łl]|kilka|kilku|par[ęe]|one|two|three|four|five|six|seven|eight|nine)$/iu;
/** Numerals from ten up, hundreds, thousands, millions and their slang: always an amount in words. */
const BIG = new RegExp(
  `^(?:${[
    // 10–19, 20–90
    "dziesi[ęe][ćc]|dziesi[ęe]ciu",
    "(?:jede|dwa|trzy|czter|pi[ęe]t|szes|siedem|osiem|dziewi[ęe]t|kilka|kilku|par[ęe])na(?:[śs]cie|stu|stoma)",
    "(?:dwa|dwu|trzy|czter|pi[ęe][ćc]|pi[ęe]ciu|sze[śs][ćc]|sze[śs]ciu|siedem|siedmiu|osiem|o[śs]miu|dziewi[ęe][ćc]|dziewi[ęe]ciu|kilka|kilku)dzie\\p{L}*",
    // hundreds
    "sto|stu|dwie[śs]cie|dwustu|trzyst[au]|czteryst[au]|(?:pi[ęe][ćc]|pi[ęe]ciu|sze[śs][ćc]|sze[śs]ciu|siedem|siedmiu|osiem|o[śs]miu|dziewi[ęe][ćc]|dziewi[ęe]ciu|kilka|kilku|par[ęe])set",
    // thousands, millions, one and a half
    // Not Tysiąclecia, a street.
    "(?!tysi[ąa]clec)tysi\\p{L}*|tys|ty[śs]|milion\\p{L}*|miliard\\p{L}*|mln|p[óo][łl]tor\\p{L}*",
    // slang
    "st[óo]w\\p{L}*|stow[aeyk]\\p{L}*|setk\\p{L}*|setek|kafel\\p{L}*|kafl\\p{L}*|patyk\\p{L}*|patol\\p{L}*|dych\\p{L}*|dysz\\p{L}*|pi[ńn]cet\\p{L}*|piencet|ba[ńn]k[aiąeę]|baniek",
    // English
    // Not "ten", which is Polish for "this".
    "eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fourty|fifty|sixty|seventy|eighty|ninety|hundreds?|thousands?|grand|millions?|dozens?",
    // times as much
    "twice|thrice|dwukrotn\\p{L}*|trzykrotn\\p{L}*",
  ].join("|")})$`,
  "iu",
);
/** Thousands after a numeral, and nothing on their own: "dwa koła", "five k". */
const SCALE_AFTER = /^(?:ko[łl][aoy]|k[óo][łl]|k|kk)$/iu;
/** Between numerals, joins them into one: "one point five", "tysiąc i pięćset". */
const NUMERAL_JOIN = /^[\s,\-–—]*(?:(?:i|and|point|przecinek|comma)[\s,\-–—]+)?$/iu;
/** Next to a small numeral, makes it a count or a multiplier: "dwa razy 750", "750 razy dwa". */
const COUNTED = /^(?:razy|times|x|po|rat\p{L}*|installments?)$/iu;
/** The same again, in words: "i drugie tyle za wysyłkę". */
const AGAIN =
  /(?<![\p{L}])(?:drugie\s+tyle|jeszcze\s+raz\s+tyle|tyle\s+samo\s+jeszcze)(?![\p{L}])/giu;

/**
 * Amounts written in words, in English or Polish, slang included: any numeral from ten up, two numerals
 * together ("fifteen fifty", "six oh oh"), or a small one used as a count ("dwa razy"). A numeral right
 * after digits is part of that number ("1,5 tys."), and one before a unit counts days or percent.
 */
export function numberWords(raw: string): string[] {
  const text = plain(raw);
  const words = [...text.matchAll(/\p{L}+/gu)].map((m) => ({
    w: m[0],
    at: m.index ?? 0,
    end: (m.index ?? 0) + m[0].length,
  }));
  const numeral = (i: number) => {
    const w = words[i]?.w ?? "";
    return SMALL.test(w) || BIG.test(w) || /^oh$/i.test(w);
  };
  const joined = (i: number, j: number) => {
    const a = words[i];
    const b = words[j];
    return !!a && !!b && NUMERAL_JOIN.test(text.slice(a.end, b.at));
  };
  /** The numeral word after `i`, past a joining word: "one point five". */
  const next = (i: number) =>
    numeral(i + 1) && joined(i, i + 1)
      ? i + 1
      : /^(?:i|and|point|przecinek|comma)$/i.test(words[i + 1]?.w ?? "") &&
          numeral(i + 2) &&
          joined(i, i + 2)
        ? i + 2
        : null;
  const out: string[] = [];
  const taken = new Set<number>();
  for (let i = 0; i < words.length; i++) {
    const cur = words[i];
    if (!cur || taken.has(i) || !numeral(i)) continue;
    const before = text.slice(0, cur.at);
    // 1,5 tys., 2 tysiące: part of the number before it.
    if (
      /\d\s?$/.test(before) &&
      (THOUSANDS.test(cur.w) || HUNDREDS.test(cur.w) || MILLIONS.test(cur.w))
    )
      continue;
    // A phrase of numerals: two together are always an amount in words.
    const phrase = [i];
    for (let j = next(i); j !== null; j = next(j)) phrase.push(j);
    const lastAt = phrase.at(-1) ?? i;
    const last = words[lastAt];
    const following = words[lastAt + 1];
    const after = text.slice(last?.end ?? cur.end);
    if (UNIT.test(after) && !/^oh$/i.test(cur.w)) {
      for (const k of phrase) taken.add(k);
      continue;
    }
    const scaleNext =
      following &&
      SCALE_AFTER.test(following.w) &&
      /^\s*$/.test(text.slice(last?.end, following.at));
    const big = phrase.some((k) => BIG.test(words[k]?.w ?? ""));
    const preceding = words[i - 1];
    const counted =
      (!!following && COUNTED.test(following.w)) ||
      (!!preceding && COUNTED.test(preceding.w) && /^\s*$/.test(text.slice(preceding.end, cur.at)));
    const counts =
      phrase.length > 1 ||
      big ||
      scaleNext ||
      counted ||
      // 750 zł dwa razy: right after an amount.
      /\d\s*(?:zł|zl|pln)?\.?\s*$/iu.test(before);
    if (/^oh$/i.test(cur.w) && phrase.length === 1) continue;
    for (const k of phrase) taken.add(k);
    if (!counts) continue;
    // "dwa koła" is one amount; elsewhere each word is quoted on its own.
    if (scaleNext && following) {
      for (const k of phrase.slice(0, -1)) out.push(words[k]?.w ?? "");
      out.push(`${last?.w} ${following.w}`);
      taken.add(lastAt + 1);
    } else for (const k of phrase) out.push(words[k]?.w ?? "");
  }
  for (const m of text.matchAll(AGAIN)) out.push(m[0]);
  return out;
}

// ——— Paying and delivery ———

/** Ways to pay. Bringing one up asks unless the mandate's delivery terms name it. */
const PAYMENTS: { name: string; re: RegExp }[] = [
  {
    name: "BLIK",
    re: /(?<![\p{L}])(?:blik\p{L}*|na\s+(?:m[óo]j\s+|pana\s+|pani\s+|tw[óo]j\s+)?(?:numer\s+)?telefon\p{L}*|na\s+(?:pana|pani|tw[óo]j|m[óo]j)\s+numer|to\s+(?:your|my)\s+(?:phone\s+)?number)/iu,
  },
  {
    name: "a bank transfer",
    re: /(?<![\p{L}])(?:przelew\p{L}*|przela[ćcłl]\p{L}*|przelej\p{L}*|przelej[eę]|kont[aou]?|koncie|kontem|rachun\p{L}*|wp[łl]at\p{L}*|wp[łl]ac\p{L}*|iban|transfer(?:s|y|u|em|ed|ring)?|wire|przekaz\p{L}*\s+(?:pocztow\p{L}*|pieni\p{L}*))(?![\p{L}])/iu,
  },
  {
    // Paying when it's handed over or arrives is cash, whatever it's called.
    name: "cash",
    re: /(?<![\p{L}])(?:got[óo]wk\p{L}*|got[óo]wce|cash|(?:zap[łl]ac\p{L}*|p[łl]ac\p{L}*|p[łl]atno\p{L}*|pay\p{L}*)\s+(?:\p{L}+\s+)?(?:po\s+otrzymaniu|przy\s+odbiorze|na\s+miejscu|do\s+r[ęe]ki|z\s+r[ęe]ki\s+do\s+r[ęe]ki|on\s+(?:arrival|delivery|pickup|collection)|in\s+person))(?![\p{L}])/iu,
  },
  { name: "cash on delivery", re: /(?<![\p{L}])pobrani\p{L}*/iu },
  { name: "PayPal", re: /(?<![\p{L}])(?:pay[\s-]?pal\p{L}*|pej[\s-]?pal\p{L}*)/iu },
  { name: "Revolut", re: /(?<![\p{L}])re[wv]olut\p{L}*/iu },
  {
    name: "crypto",
    re: /(?<![\p{L}])(?:krypto\p{L}*|crypto\p{L}*|bitcoin\p{L}*|btc|usdt|usdc|ethereum|monero|xmr|ltc|litecoin\p{L}*|doge\p{L}*)(?![\p{L}])/iu,
  },
  {
    name: "a money transfer service",
    re: /(?<![\p{L}])(?:western\s+union|moneygram\p{L}*|skrill\p{L}*|allegro\s+pay\p{L}*|payoneer\p{L}*|wise|zelle|venmo|cash\s?app|google\s?pay|apple\s?pay|g\s?pay)(?![\p{L}])/iu,
  },
  {
    name: "a gift card",
    re: /(?<![\p{L}])(?:kart\p{L}*\s+podarunkow\p{L}*|bon\p{L}*\s+podarunkow\p{L}*|gift\s?cards?|paysafe\p{L}*|voucher\p{L}*)(?![\p{L}])/iu,
  },
  {
    name: "paying off the platform",
    re: /(?<![\p{L}])(?:poza\s+(?:olx\p{L}*|allegro\p{L}*|vinted\p{L}*|platform\p{L}*|serwis\p{L}*|portal\p{L}*|aplikacj\p{L}*)|off[\s-](?:the\s+)?(?:platform|site|app)|bezpo[śs]redni\p{L}*|directly)(?![\p{L}])/iu,
  },
  {
    name: "a deposit",
    re: /(?<![\p{L}])(?:zaliczk\p{L}*|zadat(?:ek|ku|kiem)|przedp[łl]at\p{L}*|z\s+g[óo]ry|deposit\p{L}*|prepay\p{L}*|upfront|up\s+front|in\s+advance)(?![\p{L}])/iu,
  },
];

/** A card's past in mining: "do kopania kryptowalut", "crypto mining". Not a way to pay. */
const MINING =
  /(?<![\p{L}])(?:(?:kopa\p{L}*|kopa[łl]\p{L}*|wydobyw\p{L}*)\s+(?:krypto\p{L}*|bitcoin\p{L}*|btc|eth|ethereum)|(?:crypto|bitcoin|btc|eth|ethereum)\s+mining|mining\s+(?:crypto\p{L}*|bitcoin|btc|eth|ethereum))(?![\p{L}])/giu;

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
  /(?<![\p{L}])(?:odbi[óo]r\p{L}*|odbier\p{L}*|odebra\p{L}*|osobi[śs]cie|spotka\p{L}*|podjad\p{L}*|podjech\p{L}*|przyjad\p{L}*|przyjech\p{L}*|wpa[śs][ćc]|wpadn\p{L}*|przyj[śs][ćc]|przyjd[eę]|przyjdziemy|podej[śs][ćc]|podejd[eę]|zgarn\p{L}*|dojad[eę]|dojecha[ćc]|dojedziemy|zabior[eę]|zabra[ćc]|zabierzemy|pick(?:\s+\p{L}+)?(?:\s|-)?up|collect\p{L}*|in\s+person|meet\p{L}*|podskocz\p{L}*|skocz[ęe]\s+po|pojad[ęe]\s+do|b[ęe]d[ęe]\s+u\s+(?:pana|pani|ciebie|was|pa[ńn]stwa)|u\s+(?:pana|pani|ciebie|pa[ńn]stwa)(?=\s*[?.!,]|\s*$)|z\s+r[ęe]ki\s+do\s+r[ęe]ki|come\s+(?:by|over|round|(?:and\s+)?get)|swing\s+by|drop\s+by|stop\s+by|grab\s+it|drive\s+over|hand\s*over|hand\s+it\s+over|(?:at|to)\s+your\s+(?:place|house|home))(?![\p{L}])/iu;
/** "Spotkajmy się w połowie", "meet in the middle": haggling, not meeting. */
const MIDDLE =
  /(?<![\p{L}])(?:spotka\p{L}*\s+(?:si[ęe]\s+)?(?:w\s+po[łl]owie|po[śs]rodku|na\s+[śs]rodku)|meet\s+(?:you\s+)?(?:in\s+the\s+middle|halfway|half\s+way))(?![\p{L}])/giu;
/** A parcel or a locker in the sentence: "odbiorę w paczkomacie" collects a parcel. */
const PARCEL =
  /(?<![\p{L}])(?:paczk\p{L}*|paczkomat\p{L}*|przesy[łl]k\p{L}*|parcel\p{L}*|locker\p{L}*|kurier\p{L}*|courier\p{L}*)(?![\p{L}])/iu;
/** Coming in person, whatever else the sentence says. */
const IN_PERSON =
  /(?<![\p{L}])(?:osobi[śs]cie|osobist\p{L}*|in\s+person|spotka\p{L}*|meet\p{L}*|podjad\p{L}*|podjech\p{L}*|przyjad\p{L}*|przyjech\p{L}*|u\s+(?:pana|pani|ciebie|pa[ńn]stwa))(?![\p{L}])/iu;
const COLLECT =
  /(?<![\p{L}])(?:odbi[óo]r\p{L}*|odbier\p{L}*|odebra\p{L}*|collect\p{L}*|pick(?:\s+\p{L}+)?(?:\s|-)?up)(?![\p{L}])/giu;

/** The text with what only sounds like coming in person blanked: haggling, collecting a parcel. */
function inPerson(text: string): string {
  return text
    .replace(MIDDLE, " ")
    .split(/(?<=[.!?])\s+/)
    .map((sentence) =>
      PARCEL.test(sentence) && !IN_PERSON.test(sentence)
        ? sentence.replace(COLLECT, " ")
        : sentence,
    )
    .join(" ");
}
/** Sending it by post or courier. */
const SHIPPING =
  /(?<![\p{L}])(?:wysy[łl]k\p{L}*|przesy[łl]k\p{L}*|kurier\p{L}*|paczkomat\p{L}*|paczk\p{L}*|inpost\p{L}*|dpd|dhl|gls|poczt\p{L}*|dostaw\p{L}*|wys[łl]a[ćc]|wy[śs]l\p{L}*|wysy[łl]a\p{L}*|prze[śs]l\p{L}*|przes[łl]a[ćc]|nada[ćc]|nadani\p{L}*|ship\p{L}*|deliver\p{L}*|courier\p{L}*|parcel\p{L}*|postage|post\s+it|send\s+it)(?![\p{L}])/iu;
/** Saying something was paid or sent: only the owner can say that. */
const PAID =
  /(?<![\p{L}])(?:(?:za|o|w|do|prze)?p[łl]aci[łl](?:em|am|[ae][śs]my|y[śs]my)|prze[łl]a[łl](?:em|am|[ae][śs]my)|wys[łl]a[łl](?:em|am|[ae][śs]my)|przes[łl]a[łl](?:em|am|[ae][śs]my)|nada[łl](?:em|am|[ae][śs]my)|(?<!(?:zostanie|zostan[ąa]|b[ęe]dzie|b[ęe]d[ąa]|by[ćc]|kiedy|czy)\s+)(?:(?:za|o|w)p[łl]acon\p{L}*|przelan[eaoy]|wys[łl]an[eaoy]|przes[łl]an[eaoy]|nadan[eaoy])|dokona[łl]\p{L}*\s+(?:\p{L}+\s+)?(?:p[łl]atno|zap[łl]at|przelew|wp[łl]at)\p{L}*|kupi[łl](?:em|am)\s+(?:ju[żz]|przez)|completed\s+(?:the\s+)?payment|payment\s+completed|(?:kasa|pieni[ąa]dze|[śs]rodki|money|funds)\s+(?:s[ąa]|jest|is|are)\s+(?:ju[żz]\s+|already\s+)?(?:u\s+(?:pana|pani|ciebie)|with\s+you|in\s+your\s+account|na\s+(?:pana|pani|twoim)\s+koncie)|(?:kasa|kas[eę]|pieni[ąa]dze|[śs]rodki|p[łl]atno[śs][ćc]|zap[łl]ata|wp[łl]ata|przelew|money|funds|payment|transfer)\s+(?:\p{L}+\s+)?(?:posz[łl]\p{L}*|poszed[łl]|wys[łl]an\p{L}*|wykonan\p{L}*|zrobion\p{L}*|zlecon\p{L}*|zrealizowan\p{L}*|zaksi[ęe]gowan\p{L}*|dotar[łl]\p{L}*|sent|done|made|complete\p{L}*|gone\s+through|went\s+through|on\s+(?:the|its)\s+way)|zrobi[łl](?:em|am)\s+przelew|uregulowa[łl]\p{L}*|pu[śs]ci[łl]\p{L}*|i(?:['’]ve|\s+have)?\s+(?:already\s+)?(?:paid|sent|transferred|wired|shipped|posted)|sent\s+(?:you|it|the\s+money|the\s+payment)|payment\s+(?:is\s+|has\s+been\s+|was\s+)?(?:sent|made|done|complete\p{L}*)|already\s+paid|(?<=^|[.!?]\s{0,3})paid)(?![\p{L}])/iu;

/** Sending an offer or a photo isn't a claim that something was paid or sent. */
const SENT_NOT_PAID =
  /(?<![\p{L}])(?:wys[łl]a|przes[łl]a|sent)\p{L}*\s+(?:panu\s+|pani\s+|you\s+|ci\s+)?(?:an?\s+|moj\p{L}*\s+|my\s+)?(?:propozycj|ofert|offer|wiadomo|zdj[ęe]|pytani|message|photo|question)\p{L}*/giu;

// ——— Contacts and links ———

/**
 * Phone numbers: nine to fifteen digits with nothing but a few non-letters between them, whatever those
 * are: 600 700 800, +48 600-700-800, 600 | 100 | 200, 600, 100, 200.
 */
export function phonesIn(text: string): string[] {
  const digits = [...text.matchAll(/(?:\+|00)?\d(?:[^\p{L}\d]{0,3}\d){8,}/gu)]
    .map((m) => m[0])
    .filter((p) => p.replace(/\D/g, "").length <= 15);
  // 600 i 100 i 200, 600 ... 100 ... 200: three groups of three with a few words between, no money.
  const spread = [
    ...text.matchAll(
      /(?<![\d.,])\d{3}(?![\d.,]\d|\d)(?:[^\d]{1,15}?(?<![\d.,])\d{3}(?![\d.,]\d|\d)){2}/gu,
    ),
  ]
    .map((m) => m[0])
    .filter((p) => !CURRENCY_BEFORE.test(p) && !/zł|zl|pln|€|\$/iu.test(p));
  return [...digits, ...spread];
}

/** E-mail providers, as people name them when they spell an address out. */
const PROVIDERS =
  "g\\s?mail|wp|onet|o2|02|interia|yahoo|outlook|hotmail|icloud|proton(?:mail)?|op|gazeta|tlen|vp|poczta";
const EMAIL = /[\p{L}\p{N}._%+-]+\s?@\s?\p{L}[\p{L}\p{N}-]*(?:\.[\p{L}\p{N}-]+)*/giu;
/** name at gmail dot com, name(at)wp.pl, name małpa onet kropka pl. */
const EMAIL_SPELT = new RegExp(
  `[\\p{L}\\p{N}._%+-]+\\s*(?:\\(at\\)|\\[at\\]|\\{at\\}|\\(małpa\\)|\\s+małpa\\s+|\\s+malpa\\s+|\\s+at\\s+(?=(?:${PROVIDERS})(?![\\p{L}])))\\s*[\\p{L}\\p{N}-]+\\s*(?:\\.|\\(dot\\)|\\[dot\\]|\\s+dot\\s+|\\s+kropka\\s+)\\s*\\p{L}{2,}`,
  "giu",
);
/** A provider and its domain with the dot left out: "jan gmail com", "wp pl". */
const EMAIL_HOST = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:${PROVIDERS})\\s*(?:[,]|\\s|kropka|dot)\\s*(?:com|pl|net|eu|me)(?![\\p{L}])`,
  "giu",
);
/** An address told by its provider: "jankowalski88 na wp", "jan na interii". */
const EMAIL_AT_PROVIDER =
  /[\p{L}\p{N}._-]{3,}\s+na\s+(?:wp|interi\p{L}*|onec\p{L}*|onet\p{L}*|gmail\p{L}*|o2|outlook\p{L}*|yahoo|hotmail\p{L}*|poczcie)(?![\p{L}])/iu;
/** Asking to move to e-mail without an address: "napisz na maila". */
const EMAIL_WORD =
  /(?<![\p{L}])(?:e-?mail\p{L}*|mail[aeu]|mailem|mejl\p{L}*|g\s?mail\p{L}*)(?![\p{L}])/iu;
/** Words before a number that make it a rating, a date or a price, not a street: "Stan 9/10", "Dam 900". */
const NOT_STREETS = new Set(
  "stan ocena kondycja bateria wygląd wyglad gwarancja wersja rozmiar model rating condition battery size version odbiór odbior termin data dnia pan pana pani panu panem państwa panstwa mogę moge ostatecznie najniżej najnizej najwięcej najwiecej".split(
    " ",
  ),
);
/** Words after "Długa 10," that end a sentence, not name a city. */
const SIGN_OFFS = new Set(
  "pozdrawiam pozdrowienia pozdro dziękuję dziekuje dzięki dzieki thanks thank regards cheers ok okej".split(
    " ",
  ),
);
const ADDRESS: { re: RegExp; street?: number; city?: number }[] = [
  { re: /(?<![\p{L}.])(?:[Uu][Ll]|[Aa][Ll]|[Oo][Ss]|[Pp][Ll])\.\s*\p{Lu}/gu },
  { re: /(?<![\p{L}.])[Uu][Ll]\s+\p{Lu}/gu },
  {
    re: /(?<![\p{L}])(?:[Uu]lic[aęy]|[Aa]le(?:ja|i|ję|je)|[Oo]siedl[eu])\s+\p{Lu}/gu,
  },
  {
    re: /\p{Lu}[\p{L}'-]+\s+(?:Street|St\.|Road|Rd\.|Avenue|Ave\.|Lane|Drive|Boulevard)(?![\p{L}])/gu,
  },
  { re: /(?<![\d-])\d{2}-\d{3}(?![\d-])/gu },
  // Adres: Długa 10, adres Jana Pawła 5.
  { re: /(?<![\p{L}])[Aa]dres\p{Ll}*\s*:?\s*(?:\p{Lu}\p{Ll}+\s+){1,3}\d{1,4}/gu },
  // Długa 10/5, Długa 10 m. 5, Jana Pawła 10/5.
  {
    re: /(\p{Lu}\p{Ll}+)(?:\s+\p{Lu}\p{Ll}+)?\s+\d{1,4}[a-zA-Z]?\s*(?:\/\s*\d{1,4}[a-zA-Z]?|(?:m|lok|apt|flat)\.?\s*\d{1,4})(?!\d)/gu,
    street: 1,
  },
  // Puławska 12, Warszawa.
  {
    re: /(\p{Lu}\p{Ll}+)\s+\d{1,3}[a-zA-Z]?,\s*(\p{Lu}\p{Ll}{2,})(?![\p{L}])/gu,
    street: 1,
    city: 2,
  },
  // Puławska 12 w Warszawie; w Warszawie, Puławska 12.
  { re: /(\p{Lu}\p{Ll}+)\s+\d{1,3}[a-zA-Z]?\s+w\s+\p{Lu}\p{Ll}{2,}/gu, street: 1 },
  {
    re: /(?<![\p{L}])w\s+\p{Lu}\p{Ll}{2,}\s*,\s+(\p{Lu}\p{Ll}+)\s+\d{1,3}[a-zA-Z]?(?![\d.,:])/gu,
    street: 1,
  },
  // na Długiej 10, przy Kasprowicza 5.
  {
    re: /(?<![\p{L}])(?:na|przy)\s+(\p{Lu}\p{Ll}+)\s+\d{1,4}[a-zA-Z]?(?![\p{N}/.,:]|\s*(?:zł|zl|pln|k|tys)(?![\p{L}]))/gu,
    street: 1,
  },
];
const APPS =
  /(?<![\p{L}])(?:whats\s?app\p{L}*|wh?ats?\s?up|[łlw]h?[ao](?:ts|c|s)ap+\p{L}*|wa\.me|telegram\p{L}*|t\.me|signal\p{L}*|viber\p{L}*|messenger\p{L}*|facebook\p{L}*|fb\.com|fejs\p{L}*|instagram\p{L}*|insta\p{L}*|snap\p{L}*|whatsik\p{L}*|whats-app\p{L}*|wechat|discord\p{L}*|skype\p{L}*|threema|sms\p{L}*|esem\p{L}*|imessage)(?![\p{L}])/iu;
/** WA, TG, FB, IG: on their own, not in Wa-wa or a domain. */
const APP_SHORT =
  /(?<![\p{L}\p{N}.@-])(?:wa|tg|fb|ig|snap)(?![\p{L}\p{N}-])|(?<![\p{L}])na\s+tele(?![\p{L}])/iu;

/** Contact details in a message, by the kind the mandate can allow. */
export function contactsIn(raw: string): { kind: MandateContact; raw: string }[] {
  const text = plain(raw);
  const out: { kind: MandateContact; raw: string }[] = [];
  const phone = phonesIn(blankDates(text))[0];
  if (phone) out.push({ kind: "phone", raw: phone.trim() });
  const email = [EMAIL, EMAIL_SPELT, EMAIL_HOST, EMAIL_AT_PROVIDER, EMAIL_WORD]
    .map((re) => text.match(re)?.[0])
    .find(Boolean);
  if (email) out.push({ kind: "email", raw: email });
  const address = ADDRESS.flatMap(({ re, street, city }) =>
    [...text.matchAll(re)].filter((a) => {
      const word = street ? (a[street]?.toLowerCase() ?? "") : "";
      return !(
        street &&
        (NOT_STREETS.has(word) ||
          priceWord(word) ||
          (city && SIGN_OFFS.has(a[city]?.toLowerCase() ?? "")))
      );
    }),
  )[0];
  if (address) {
    const at = address.index ?? 0;
    out.push({ kind: "address", raw: text.slice(at, at + 40).split(/[,;\n]/)[0] ?? "" });
  }
  const app = APPS.exec(text)?.[0] ?? APP_SHORT.exec(text)?.[0];
  if (app) out.push({ kind: "apps", raw: app });
  return out;
}

/** Top-level domains a dot with spaces around it is undone before even with nothing after them. */
const TLDS =
  "pl|com|net|org|eu|io|me|ly|info|app|xyz|shop|link|co|online|top|site|store|club|biz|cc|tk|ml|ga|cf|gq|icu|live|vip|win|fun|space|website|tech|pro|ru|cn|de|cz|uk|us";
/** Dots and schemes written so a filter misses them: olx[.]pl, olx (dot) pl, evil . co/x, hxxps://. */
const undefang = (s: string) =>
  s
    .replace(/\s*[[({<]\s*(?:\.|dot|kropka)\s*[\])}>]\s*/giu, ".")
    .replace(/\s+(?:dot|kropka)\s+(?=[\p{L}\p{N}])/giu, ".")
    // olx . pl, evil. co/pay, olx-pay . top: a host's dot, by what follows it or by the host.
    .replace(
      /([\p{L}\p{N}-]+)\s*\.\s+((?:\p{L}{2,24}|xn--[a-z0-9-]+))(?=([/:])|(?![\p{L}\p{N}-]))/giu,
      (all, host: string, tld: string, path: string | undefined) =>
        path || host.includes("-") || new RegExp(`^(?:${TLDS})$`, "i").test(tld)
          ? `${host}.${tld}`
          : all,
    )
    // olx-dostawa,pl/abc: a comma for the dot, before a path.
    .replace(new RegExp(`([\\p{L}\\p{N}-]+)\\s?,\\s?(${TLDS})(?=[/:])`, "giu"), "$1.$2")
    // evil .co: a space before a dot and none after isn't how a sentence ends.
    .replace(/([\p{L}\p{N}-]+)\s+\.(?=(?:\p{L}{2,24}|xn--[a-z0-9-]+)(?![\p{L}\p{N}-]))/giu, "$1.")
    .replace(/h(?:tt|xx|\*\*)p(s?)\s*(?:\[:\]|\(:\)|:)?\s*\/\//giu, "http$1://");
/** An address with a scheme, www., an IP address, or a host with any top-level domain. */
const LINK =
  /(?:https?|ftp):\/\/\S+|www\.\S+|(?<![\p{N}.])(?:\d{1,3}\.){3}\d{1,3}(?![\p{N}]|\.\d)(?::\d{2,5})?(?:\/\S*)?|(?<![\p{L}\p{N}@._-])((?:[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?\.)+)(?:\p{L}{2,24}|xn--[a-z0-9-]{2,59})(?![\p{L}\p{N}-])(?::\d{2,5})?(?:\/\S*)?/giu;
/** Abbreviations a sentence can run into without a space: "np.zdjęcie", "tys.zł". */
const ABBREVIATIONS = new Set(
  "np ok tzn itd itp tj ul al os pl nr godz tys zł zl r m św sw dr mgr inż inz prof ds pt jw wg ww tel ps kpl szt min max st".split(
    " ",
  ),
);

/** Links: an address with a scheme, www., an IP address or a domain, however it's disguised. They always ask. */
export function linksIn(raw: string): string[] {
  let s = plain(raw);
  for (const re of [EMAIL, EMAIL_SPELT, EMAIL_HOST]) s = s.replace(re, " ");
  s = undefang(s);
  return [...s.matchAll(LINK)]
    .filter((m) => {
      const labels = m[1];
      if (labels === undefined) return true;
      if (!/\p{L}/u.test(labels)) return false;
      const parts = labels.split(".").filter(Boolean);
      return !(parts.length === 1 && ABBREVIATIONS.has(parts[0]?.toLowerCase() ?? ""));
    })
    .map((m) => m[0]);
}
