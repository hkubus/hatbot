// negotiate_send's policy, in code rather than by a model. It fails closed: a message goes on its own
// only when the check can read all of it and finds it inside the mandate. It never sends on a guess.
import type { MandateContact, Negotiation, NegotiationMessage, Stated } from "@hatbot/shared";
import { askAlways, block, covered, type Verdict } from "../plugins/plugin";
import { collapse, sameHost } from "./gate";

export type SendInput = {
  text: string;
  offer: number | null;
  agree: boolean;
  stated: Stated | null;
};

export type SendFacts = {
  now: number;
  hour: number;
  inFlight: boolean;
  /** Nothing has gone to this seller yet: this message starts a conversation. */
  starts: boolean;
  startedToday: number;
  /** When our last message went, if the seller hasn't answered it. */
  unansweredSince: number | null;
  /**
   * Oldest first, `after` when it came after our last message went: a message that agrees without
   * naming its price agrees to theirs.
   */
  seller: { text: string; after: boolean }[];
};

/** Local time. */
export const QUIET_HOURS = { from: 22, to: 8 };
export const NEW_PER_DAY = 10;
export const PACE_MS = 2 * 60_000;

export function zl(n: number, currency?: string): string {
  const x = n.toLocaleString("en-GB", { maximumFractionDigits: 2 });
  return currency ? `${x} ${currency === "PLN" ? "zł" : currency}` : x;
}

export function sendPolicy(n: Negotiation, input: SendInput, f: SendFacts): Verdict {
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

  // A message that reads as agreeing agrees to the other side's price, so it must name its own: a number
  // read from the seller's message is never trusted for a bare "Zgoda". While their price is past the
  // limit or unreadable, only a message naming a price of ours inside the mandate goes at all.
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

export const CONTACT_NAMES: Record<MandateContact, string> = {
  phone: "a phone number",
  email: "an e-mail address",
  address: "an address",
  apps: "another app",
};

/**
 * Anything else (an emoji, a combining mark, an invisible filler, another script, a look-alike digit)
 * asks rather than being mapped to what it might mean.
 */
const READABLE =
  /^[A-Za-z0-9ąćęłńóśźżĄĆĘŁŃÓŚŹŻáčďéěíňřšťúůýžÁČĎÉĚÍŇŘŠŤÚŮÝŽ .,!?:;'"’‘„”“«»()[\]\-–—/%+&@#*=_×°\p{Sc}]$/u;

function unreadableChars(text: string): string[] {
  const odd = [...new Set(collapse(text))].filter((c) => !READABLE.test(c));
  return odd.map((c) => {
    const code = `U+${(c.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`;
    return /^[\p{L}\p{N}\p{P}\p{S}]$/u.test(c) && !/\p{Default_Ignorable_Code_Point}/u.test(c)
      ? `"${c}" ${code}`
      : code;
  });
}

/** Odd characters in a word with digits: 1️⃣5️⃣0️⃣0️⃣, 1͏500, 15ОО. An emoji on its own is fine. */
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

const clean = (text: string) =>
  collapse(text)
    .replace(/[\p{M}\p{Default_Ignorable_Code_Point}]/gu, "")
    .replace(/\u2800/g, " ")
    // A browser reads ideographic full stops as dots in an address.
    .replace(/[\u3002\ufe12]/g, ".")
    .replace(/\p{Nd}/gu, (d) => (d >= "0" && d <= "9" ? d : String(digitValue(d))))
    .replace(/٫/g, ".")
    .replace(/٬/g, ",")
    .replace(/ {2,}/g, " ");

const LOOK_ALIKE = /(?<![\p{L}\p{N}])[\dOoОоΟοlIІіӀӏ]*\d[\dOoОоΟοlIІіӀӏ]*(?![\p{L}\p{N}])/gu;

export function plain(text: string): string {
  return clean(text).replace(LOOK_ALIKE, (w) =>
    w.replace(/[OoОоΟο]/g, "0").replace(/[lIІіӀӏ]/g, "1"),
  );
}

/** 15OO, l500, 1k5, 15o0; and look-alikes alone where an amount goes: "IOOO zł", "Dam lOOO". */
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

/** "B L I K", "W.h.a.t.s": every word check reads past them. */
const spelledOut = (text: string) =>
  [...clean(text).matchAll(/(?<![\p{L}\p{N}])\p{L}(?:[\s.\-*_]\p{L}){3,}(?![\p{L}\p{N}])/gu)].map(
    (m) => m[0],
  );

/** Not right after "nie": "nie kupię za tyle" refuses. */
const ACCEPT =
  /(?<![\p{L}])(?<!(?:^|[^\p{L}])nie\s+)(?:bior[eę]|wezm[eę]|kupuj[eę]|kupi[eę]|kupione|zgoda|zgadzam\s+si[eę]|zgadzamy\s+si[eę]|zgodz[eę]\s+si[eę]|umow[aęe]|umówi(?:eni|one|ona|ony)|umowi(?:eni|one|ona|ony)|niech\s+(?:\p{L}+\s+)?b[eę]dzie|akceptuj[eę]|przyjmuj[eę]|dobijamy|dobili[śs]my|dogadali[śs]my|dogadane|klepni[eę]te|zaklepane|wchodz[eę](?:\s+w\s+to)?|jestem\s+za(?=\s*(?:[.!,;]|$))|(?:dobra|ok|okej|umowa)\s*,?\s+stoi|(?<!(?:panu|pani|ci|wam|pa[ńn]stwu)\s+)pasuje(?=\s*(?:mi(?![\p{L}])|[.!,;]|$))|mi\s+pasuje|mo[żz]e\s+by[ćc](?=\s*(?:[.!,;]|$))|(?<=(?:^|[.!,;:]\s*|(?:it['’]?s|it\s+is|that['’]?s|that\s+is|got|ok(?:ay)?)\s+(?:a\s+)?))deal(?=\s*(?:[.!,;:]|$))|deal\s+at|agreed|i\s+agree|i\s+accept|accepted|(?:i(?:['’]ll|\s+will)|will)\s+(?:take|buy)\s+it)(?![\p{L}])/iu;

/**
 * Agreeing to the other side's price without a plain yes: "za Pana cenę", "idę na to". Accusative
 * only: "Pana cena jest za wysoka" refuses. Unlike ACCEPT they don't block; they count as agreeing.
 */
const AGREES =
  /(?<![\p{L}])(?:mi\s+odpowiada|odpowiada\s+mi|id[ęe]\s+na\s+to|przystaj[ęe]|przekona[łl]\p{L}*\s+mnie|rezerwuj[ęe]|za[łl]atwione|mo[żz]e\s+by[ćc]\s+i\s+tak|czemu\s+nie|why\s+not|you\s+win|got\s+(?:yourself\s+)?a\s+deal|i(?:['’]ll|\s+will)\s+(?:buy|take\s+(?:the|this|that|your))|works\s+for\s+me|let['’]?s\s+do\s+it|count\s+me\s+in|sold|(?:pana|pani|your)\s+(?:warunki|terms)|cena\s+jest\s+w\s+porz[ąa]dku|price\s+is\s+(?:fine|ok|okay|good|right)|(?:pana|pani|pa[ńn]sk\p{L}*|pa[ńn]stwa|tw[oó]j\p{L}*|tw[aą])\s+(?:cen[eę]|propozycj[eę]|ofert[eę]|kwot[eę])|tyle\s*,?\s+(?:ile|co)|ile\s+(?:pan|pani|pa[ńn]stwo)\s+\p{L}+|(?:pay|take|accept|meet|at|for)\s+your\s+(?:asking\s+)?(?:price|offer)|what\s+you(?:['’]re|\s+are)?\s+ask\p{L}*|asking\s+price|full\s+price|pe[łl]n[aąe]\s+cen[eęy]|cen[eęy]\s+(?:wywo[łl]awcz\p{L}*|z\s+og[łl]oszenia|katalogow\p{L}*))(?![\p{L}])/iu;

const AFFIRMATIVE_ONLY =
  /^[\s.,!…-]*(?:(?:ok(?:ay|ej|i)?|tak|dobrze|dobra|jasne|pewnie|spoko|super|[śs]wietnie|git|zgoda|fine|sure|yes|yeah|yep|great|perfect|alright|cool|deal|sold|w\s+porz[ąa]dku|no\s+to|to|poprosz[ęe]|please|sounds\s+good|that\s+works|w\s+takim\s+razie|then)[\s.,!…-]*)+$/iu;
/** After a price past the limit, a message that opens with yes reads as taking it. */
const AFFIRMATIVE_OPENING =
  /^\s*(?:ok(?:ay|ej|i)?|tak|dobrze|dobra|jasne|pewnie|spoko|super|[śs]wietnie|git|zgoda|fine|sure|yes|yeah|yep|great|perfect|alright|all\s+right|cool|sold|deal|w\s+porz[ąa]dku|czemu\s+nie|why\s+not)(?![\p{L}])/iu;
/** The least that's a price rather than a fee or a count: half the opening offer, or of the limit. */
const priceFloor = (m: Negotiation["mandate"]) => Math.min(m.opening, m.limit) / 2;

export function acceptance(raw: string): string | null {
  return ACCEPT.exec(plain(raw))?.[0] ?? null;
}

/**
 * The worst price they named since our last message, else the latest they named, else the asking price.
 * Null when it can't be read for certain.
 */
function theirPrice(n: Negotiation, seller: SendFacts["seller"]): number | null {
  const worst = (xs: number[]) => (n.role === "buy" ? Math.max(...xs) : Math.min(...xs));
  const reading = (raw: string) => priceReading(n, raw);
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

function priceReading(n: Negotiation, raw: string) {
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
}

export const STALL_ROUNDS = 3;

/**
 * The price the seller has kept to through the last three of our offers they answered, each sent after
 * message `since`, while ours stayed short of it. A round counts only when every reply names a price:
 * a bare "nie", a question or an acceptance isn't a price kept to. Unlike the send policy's, the reading
 * takes the best price they named, so a seller who moved at all hasn't stalled.
 */
export function stalled(
  n: Negotiation,
  messages: NegotiationMessage[],
  since: number | null,
): number | null {
  const best = (xs: number[]) => (n.role === "buy" ? Math.min(...xs) : Math.max(...xs));
  const theirs = messages.filter((m) => m.direction === "in");
  const ours = messages.filter(
    (m) => m.direction === "out" && (m.status === "sent" || m.status === "unconfirmed"),
  );
  const rounds = ours.flatMap((o, i) => {
    const next = ours[i + 1]?.id ?? Number.POSITIVE_INFINITY;
    const replies = theirs.filter((m) => m.id > o.id && m.id < next);
    return o.offer !== null && o.id > (since ?? 0) && replies.length
      ? [{ id: o.id, offer: o.offer, replies: replies.map((m) => priceReading(n, m.text)) }]
      : [];
  });
  const last = rounds.slice(-STALL_ROUNDS);
  const first = last[0];
  const latest = last.at(-1);
  if (!first || !latest || last.length < STALL_ROUNDS) return null;
  let before = n.asking;
  for (const m of theirs.filter((x) => x.id < first.id).toReversed()) {
    const r = priceReading(n, m.text);
    if (r.unclear) return null;
    if (r.values.length) {
      before = best(r.values);
      break;
    }
  }
  if (before === null) return null;
  for (const round of last)
    for (const r of round.replies)
      if (r.unclear || !r.values.length || best(r.values) !== before) return null;
  return (n.role === "buy" ? latest.offer < before : latest.offer > before) ? before : null;
}

const FIRM =
  /(?<![\p{L}])(?:cen\p{L}*\s+(?:jak\s+w\s+og[łl]oszeniu|z\s+og[łl]oszenia|bez\s+zmian|ostateczn\p{L}*|sztywn\p{L}*|nie\s+podlega\p{L}*|aktualn\p{L}*)|nie\s+negocjuj\p{L}*|bez\s+negocjacji|nie\s+zejd[ęe]|nie\s+opuszcz\p{L}*|price\s+(?:as\s+listed|stays|is\s+firm|is\s+final|is\s+fixed)|asking\s+price|full\s+price|not\s+negotiable|no\s+negotiation)(?![\p{L}])/iu;

const SEVERAL_ITEMS =
  /(?<![\p{L}])(?:obie|oba|obydw\p{L}*|both|w\s+parze|tylko\s+razem|as\s+a\s+pair|(?:wszystkie|all)\s+(?:trzy|cztery|three|four|of\s+them|karty|sztuki|cards)|drug[aąi]\s+(?:kart\p{L}*|sztuk\p{L}*|egzemplarz\p{L}*)|second\s+(?:card|one|item))(?![\p{L}])/iu;

const REMAINDER =
  /(?<![\p{L}])(?:reszt[aęy]|r[óo][żz]nic[aęy]|brakuj[ąa]c\p{L}*\s+kwot\p{L}*|the\s+(?:rest|difference|remainder|balance))(?![\p{L}])/iu;
const PAY_VERB =
  /(?<![\p{L}])(?:dop[łl]ac\p{L}*|dop[łl]at\p{L}*|zap[łl]ac\p{L}*|p[łl]ac\p{L}*|oddam|odda[ćc]|dam|dorzuc\p{L}*|przelej\p{L}*|przela\p{L}*|wy[śs]l[ęe]|pay\p{L}*|send)(?![\p{L}])/iu;
const RELATIVE: RegExp[] = [
  // Any share but 100%, which is a manner of speaking ("sprawna w 100%").
  /(?<![\d.,])(?!100(?![\d.,]))\d+(?:[.,]\d+)?\s?(?:%|procent\p{L}*|percent)/giu,
  /(?<![\p{L}])(?:netto|(?:\+|plus)\s*vat)(?![\p{L}])/giu,
  // Shipping on top with no amount: "1400 zł + wysyłka" is more than 1400 zł, by how much isn't said.
  /(?:\+|(?<![\p{L}])plus)\s*(?:(?:koszt\p{L}*|op[łl]at\p{L}*|cost\s+of)\s+)?(?:wysy[łl]k\p{L}*|przesy[łl]k\p{L}*|dostaw\p{L}*|kurier\p{L}*|shipping|postage|delivery)(?![\p{L}])(?!\s*(?:\p{L}+\s+){0,2}\d)/giu,
  /\d+(?:[.,]\d+)?\s*(?:zł|zl|pln|złotych)?\s+(?:wi[ęe]cej|mniej|taniej|dro[żz]ej|extra|more|less|cheaper|off)(?![\p{L}])/giu,
  /(?<![\p{L}])(?:zej[śs][ćc]|zejd\p{L}*|opu[śs]ci\p{L}*|opuszcz\p{L}*|obni[żz]\p{L}*|podnie[śs]\p{L}*|podnios\p{L}*|podbi\p{L}*|zwi[ęe]ksz\p{L}*|spu[śs]ci\p{L}*|dorzuc\p{L}*|do[łl]o[żz]\p{L}*)\s+(?:o\s+)?\d+/giu,
  /(?<![\p{L}])(?:(?:\d+|dwa|trzy|two|three)\s*(?:x|×|razy|times)\s+(?:tyle|that|as\s+much)|podw[óo]jnie|potr[óo]jnie|pay\s+double|double\s+(?:the|your|that|it|what)|triple\s+(?:the|your|that|it)|o\s+po[łl]ow[ęe]|(?:p[óo][łl]|po[łl]ow[ęe]|po[łl]owa)\s+ceny|half\s+(?:the\s+)?price|half\s+of\s+(?:the|your|what))(?![\p{L}])/giu,
  /(?<![\p{L}])(?:(?:do|ponad|od)\s+(?:pana|pani|pa[ńn]sk\p{L}*|twoj\p{L}*|pa[ńn]stwa)\s+cen\p{L}*|(?:on\s+top\s+of|over|above|more\s+than)\s+(?:your|the)\s+(?:asking\s+)?price|(?:pana|pani|your)\s+(?:cen\p{L}*|price)\s+(?:plus|\+))(?![\p{L}])/giu,
  /(?<![\p{L}])(?:(?:to|tyle)\s+samo\s+(?:za|jeszcze)|za\s+tyle\s+samo|the\s+same\s+(?:again|for|amount))(?![\p{L}])/giu,
  /(?<![\p{L}])(?:miesi[ęe]cznie|co\s+miesi[ąa]c|monthly|per\s+month|tygodniowo|co\s+tydzie[ńn]|weekly|na\s+raty|w\s+ratach|installments?)(?![\p{L}])/giu,
];

function relativeIn(text: string): string[] {
  const out = RELATIVE.flatMap((re) => [...text.matchAll(re)].map((m) => m[0]));
  const rest = REMAINDER.exec(text)?.[0];
  if (rest && PAY_VERB.test(text)) out.push(rest);
  return out;
}

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
/** Money only right after a number: 300 kr, 300 lei. */
const MONEY_AFTER: { code: string; words: string }[] = [
  { code: "USD", words: "zielon\\p{L}*" },
  { code: "CZK", words: "koron\\p{L}*" },
  { code: "kr", words: "kr" },
  { code: "HUF", words: "ft" },
  { code: "RON", words: "lei|lej" },
  { code: "CHF", words: "fr" },
];
/**
 * Codes no word or model name is spelt like (sek is seconds in Polish, AMD a GPU maker); any other
 * ISO code counts only right after a number: 300 TRY.
 */
const ANYWHERE = "SEK NOK DKK ISK RON BGN CAD AUD NZD CNY INR TRY ILS AED MXN BRL ZAR".split(" ");
const CODES = new RegExp(`(?<![\\p{L}])(?:${ANYWHERE.join("|")})(?![\\p{L}])`, "gu");
const ISO = new Set(Intl.supportedValuesOf("currency"));
const moneyWords = MONEY.map((c) => c.words).join("|");
const moneySigns = MONEY.flatMap((c) => (c.signs ? [c.signs] : [])).join("|");
const CURRENCY = new RegExp(`^\\s?(?:(?:${moneyWords})(?![\\p{L}])|${moneySigns})`, "iu");
const CURRENCY_BEFORE = new RegExp(`(?:(?<![\\p{L}])(?:${moneyWords})|${moneySigns})\\s?$`, "iu");

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
  const known = new RegExp(moneySigns, "u");
  for (const m of s.matchAll(/\p{Sc}/gu))
    if (!known.test(m[0])) out.push({ code: m[0], raw: near(m.index ?? 0, m[0]) });
  return out;
}

const THOUSANDS =
  /^\s?(?:k|tys\.?|tyś\.?|ty[śs]k\p{L}*|tysi\p{L}*|tysiak\p{L}*|thousands?|grand|kawa[łl]\p{L}*|kafl\p{L}*|kafel|patyk\p{L}*|patol\p{L}*|ko[łl][ao]|k[óo][łl])(?![\p{L}])/iu;
const HUNDREDS =
  /^\s?(?:st[óo]w\p{L}*|stow[aeky]\p{L}*|setk\p{L}*|setek|stuz[łl]ot[óo]w\p{L}*|hundreds?)(?![\p{L}])/iu;
const FIVE_HUNDREDS =
  /^\s?(?:pi[ęe][ćc]setk\p{L}*|pi[ęe][ćc]setek|pi[ęe][ćc]setz[łl]ot\p{L}*)(?![\p{L}])/iu;
const MILLIONS =
  /^\s?(?:kk|mln|mio|milion\p{L}*|million\p{L}*|ba[ńn]k\p{L}*|ba[ńn]i[ae]?|baniek)(?![\p{L}])/iu;
const SCALES: [RegExp, number][] = [
  [MILLIONS, 1_000_000],
  [THOUSANDS, 1000],
  [FIVE_HUNDREDS, 500],
  [HUNDREDS, 100],
];

/** No one-letter units: "2000 w gotówce" is money, not watts. */
const UNIT =
  /^\s?(?:%|procent\p{L}*|gb|tb|mb|kb|mhz|ghz|hz|mah|wh|cm|mm|km|kg|ml|cali|cale|cal|szt\.?|sztuk\p{L}*|dni|dzień|dnia|godz\.?|godzin\p{L}*|minut\p{L}*|sek\.?|tyg\.?|tygodni\p{L}*|mies\.?|miesi\p{L}*|rok|roku|lat|lata|h|fps|rpm|gen\.?|generacji|rdzeni\p{L}*|bit|bitów|days?|hours?|weeks?|months?|years?|pcs|pieces?|inch\p{L}*)(?![\p{L}\p{N}])/iu;
/** Anything else glued on asks. */
const MODEL_SUFFIX = /^(?:ti|xt|xtx|super|x(?=\d)|st|nd|rd|th|nm)(?![\p{L}])/iu;
const unitAfter = (after: string) =>
  UNIT.test(after) || MODEL_SUFFIX.test(after) || /^(?:X|XT|XTX|X3D)(?!\p{L})/u.test(after);
/** Not w, z, od, in or from on their own: "w 2000" is as likely money. */
const YEAR_BEFORE =
  /(?:^|[^\p{L}])(?:rok|roku|rocznik|since|year|(?:gwarancj\p{L}*|warranty)\s+(?:do|until|till|to)|stycz\p{L}*|lut\p{L}*|marc\p{L}*|marzec|kwie\p{L}*|maj[a]?|czerw\p{L}*|lip\p{L}*|sierp\p{L}*|wrze[śs]\p{L}*|pa[źz]dziernik\p{L}*|listopad\p{L}*|grud\p{L}*|january|february|march|april|may|june|july|august|september|october|november|december)\s$/iu;
const YEAR_AFTER = /^\s?(?:r\.|r(?![\p{L}])|rok|roku)/iu;

/** A short year only with a two-digit day and month: 1.5.00 is a number written oddly, not a date. */
const blankDates = (text: string) =>
  text
    .replace(
      /(?<![\d.,])(?:\d{1,2}([./-])\d{1,2}\1(?:19|20)\d{2}|\d{2}([./-])\d{2}\2\d{2})(?![\d.,]?\d)/g,
      (x) => " ".repeat(x.length),
    )
    .replace(/(?<!\d)\d{1,2}:\d{2}(?!\d)/g, (x) => " ".repeat(x.length));

export type Amount = { raw: string; values: number[] };

const PRICE_WORDS = new Set(
  "za do od po cena cenę cene ceny cenie cenka koszt kosztuje kwota kwotę kwote kwocie dam daję daje dać dac płacę place zapłacę zaplace oferuję oferuje proponuję proponuje biorę biore wezmę wezme max maks maksymalnie najwyżej najwyzej budżet budzet razem łącznie lacznie for pay price offer at only tylko total".split(
    " ",
  ),
);
const priceWord = (w: string | undefined) => w !== undefined && PRICE_WORDS.has(w.toLowerCase());
const modelLike = (w: string) => /^\p{Lu}+$/u.test(w) || /\p{Lu}/u.test(w.slice(1));
const lastWord = (s: string) => /(\p{L}+)[^\p{L}\p{N}]*$/u.exec(s)?.[1];

/**
 * A model number stays an amount when it's the asking price or follows a price word ("cena 1500").
 * Each separator is read every way it could be (1.500 is 1500 or 1.5), so the cap can't be dodged.
 */
export function amountsIn(text: string, title: string, asking: number | null = null): Amount[] {
  return read(text, title, asking).found.map(({ raw, values }) => ({ raw, values }));
}

type Found = Amount & { index: number; end: number; money: boolean };
type Unclear = { raw: string; spaced: boolean };
type Reading = { s: string; found: Found[]; unclear: Unclear[] };

const PHONE_SHAPE =
  /^(?:(?:\+|00)?48[\s-]?)?(?:\d{9}|\d{3}([\s.-])\d{3}\1\d{3}|\d{2}([\s.-])\d{3}\2\d{2}\2\d{2})$/;

/** Indexes are into `s`: the text as read, with dates and phone numbers blanked. */
function read(text: string, title: string, asking: number | null): Reading {
  const words = title.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  /** "hexagon 2000": a word in the title and the number after it, unless that's a price. */
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
  const judge = (raw: string, index: number, values: number[], parts: number) => {
    const before = s.slice(0, index);
    const after = s.slice(index + raw.length);
    const money = CURRENCY.test(after) || CURRENCY_BEFORE.test(before);
    const asked = asking !== null && values.includes(asking);
    if (!money && !asked) {
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
      if (/^p(?![\p{L}])/u.test(after) && /^(?:480|720|1080|1440|2160)$/.test(raw)) return;
      const word = /(\p{L}+)[\s-]$/u.exec(before)?.[1];
      // The title's number on its own ("Mogę 6800") is a price.
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
      // 1500i, 1.5kzł, 650W: an amount that can't be read for certain. Not 3D or 3x, too small to matter.
      const glued = /^\p{L}+/u.exec(after)?.[0];
      if (glued && values.some((v) => v >= 10)) unclear.push({ raw: raw + glued, spaced: false });
    }
    // "Mogę 1,5" may be thousands without the k.
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

  // A space before a number with a unit, or after the title's model number, ends a run: RTX 3070 8 GB.
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

function readings(groups: string[], seps: string[]): number[] {
  if (groups.length === 1) return [Number(groups[0])];
  const values = new Set<number>();
  const head = groups[0] ?? "";
  if (head.length <= 3 && groups.slice(1).every((g) => g.length === 3) && new Set(seps).size === 1)
    values.add(Number(groups.join("")));
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

const JOIN =
  /\+|(?<![\p{L}])(?:plus|i|oraz|dorzuc\p{L}*|do[łl]o[żz]\p{L}*|dop[łl]ac\p{L}*|do\s+tego|ponadto|jeszcze|and|extra|on\s+top)(?![\p{L}])/iu;
const APART = /(?<![\p{L}])(?:albo|lub|czy|or|zamiast|instead|nie|not)(?![\p{L}])/iu;
const MULTIPLY =
  /(?<![\d.,])(\d+(?:[.,]\d+)*)\s*(?:(?:zł|zl|pln|złotych)\.?\s*)?(?:x|×|\*|razy(?:\s+po)?|times|szt\.?(?:\s+po)?|sztuk\p{L}*(?:\s+po)?|pcs\.?|pieces?)\s*(?:po\s+|à\s*|@\s*)?(\d+(?:[.,]\d+)*)/giu;
const EACH =
  /^\s?(?:(?:zł|zl|pln|złotych)\.?\s?)?(?:za\s+(?:1\s*)?(?:sztuk[eęi]|szt\.?|każd\p{L}*|jedn\p{L}*|egzemplarz\p{L}*|egz\.?)|od\s+(?:sztuki|egzemplarza|karty)|\/\s?1?\s?(?:szt\.?|sztuk[aęi])|każd[aey]|each|apiece|a\s+piece|(?:per|for)\s+(?:item|piece|unit|one|each|card))(?![\p{L}])/iu;
/** Only when the message counts items: "1000 zł za kartę" is then a price each. */
const EACH_IF_COUNTED =
  /^\s?(?:(?:zł|zl|pln|złotych)\.?\s?)?(?:za|per|for\s+(?:the|a|each))\s+(?:kart\p{L}*|cards?|sztuk\p{L}*)/iu;

const SEVERAL =
  /(?<![\p{L}])(?:obie|oba|obydw\p{L}*|dwie|dwa|trzy|cztery|kilka|wszystk\p{L}*|both|two|three|four|several|all|pair|parze)(?![\p{L}])/iu;
const COUNT =
  /(?<![\d.,])[2-9]\d?\s*(?:,|szt\p{L}*|sztuk\p{L}*|rat\p{L}*|egz\p{L}*|pcs|pieces?|items?|x(?![\p{L}]))/iu;

type Spanned = { raw: string; total: number; index: number; end: number };

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

  // "po 750" is a price each only when it's money or the message counts items; not "podjadę po 17".
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

/** Whatever words stand between our amounts, they may be one total to the seller. */
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

const clauses = (terms: string) =>
  terms.split(
    /[,;()\n]|\.(?=\s+\p{Lu}|\s*$)|\s[-–—]\s|(?<![\p{L}])(?:but|ale|lecz|however)(?![\p{L}])/u,
  );
/** A clause with any of these rules out everything it names, whatever the wording. */
const NEGATIVE =
  /(?<![\p{L}])(?:no|not|never|none|nor|avoid\p{L}*|except|without|exclud\p{L}*|forbidden|prohibited|disallowed|unavailable|impossible|cannot|can['’]?t|don['’]?t|doesn['’]?t|won['’]?t|isn['’]?t|aren['’]?t|bez|nie\p{L}*|nigdy|brak\p{L}*|zakaz\p{L}*|opr[óo]cz|wyj[ąa]tk\p{L}*|wyklucz\p{L}*|zabronion\p{L}*|unika\p{L}*)(?![\p{L}])/iu;

function termsOf(delivery: string): { payments: Set<string>; pickup: boolean; shipping: boolean } {
  const yes = clauses(delivery).filter((c) => !NEGATIVE.test(c));
  return {
    payments: new Set(yes.flatMap((c) => paymentsIn(c).map((p) => p.name))),
    pickup: yes.some((c) => PICKUP.test(plain(c))),
    shipping: yes.some((c) => SHIPPING.test(plain(c))),
  };
}

const ON_TOP =
  /on\s+top|extra|additional|dodatkow\p{L}*|ponad|dop[łl]at\p{L}*|(?:for|za|na)\s+(?:the\s+)?(?:shipping|postage|delivery|wysy[łl]k\p{L}*|przesy[łl]k\p{L}*|dostaw\p{L}*|kurier\p{L}*|paczkomat\p{L}*)/iu;
const NOT_ON_TOP =
  /total|in\s+all|altogether|overall|includ\p{L}*|incl|w\s+tym|[łl][ąa]cznie|razem|z\s+wysy[łl]k[ąa]|insur\p{L}*|ubezpiecz\p{L}*|warto[śs]\p{L}*|value|protect\p{L}*|ochron\p{L}*|limit|maks\p{L}*|max\p{L}*|ceiling/iu;

/** Shipping on top of the price the delivery terms allow, never more than a tenth of the limit. */
export function allowance(delivery: string, limit: number): number {
  let most = 0;
  for (const c of clauses(delivery)) {
    if (!ON_TOP.test(c) || NOT_ON_TOP.test(c)) continue;
    for (const a of read(c, "", null).found) if (a.money) most = Math.max(most, ...a.values);
  }
  return Math.min(most, Math.floor(limit / 10));
}

const SMALL =
  /^(?:zero|jeden|jedna|jedno|jednego|jednej|jednym|jedn[ąa]|jednemu|dwa|dwie|dw[óo]ch|dwom|dwoma|dwiema|trzy|trzech|trzem|trzema|cztery|czterech|czterem|czterema|pi[ęe][ćc]|pi[ęe]ciu|sze[śs][ćc]|sze[śs]ciu|siedem|siedmiu|osiem|o[śs]miu|dziewi[ęe][ćc]|dziewi[ęe]ciu|p[óo][łl]|kilka|kilku|par[ęe]|one|two|three|four|five|six|seven|eight|nine)$/iu;
const BIG = new RegExp(
  `^(?:${[
    "dziesi[ęe][ćc]|dziesi[ęe]ciu",
    "(?:jede|dwa|trzy|czter|pi[ęe]t|szes|siedem|osiem|dziewi[ęe]t|kilka|kilku|par[ęe])na(?:[śs]cie|stu|stoma)",
    "(?:dwa|dwu|trzy|czter|pi[ęe][ćc]|pi[ęe]ciu|sze[śs][ćc]|sze[śs]ciu|siedem|siedmiu|osiem|o[śs]miu|dziewi[ęe][ćc]|dziewi[ęe]ciu|kilka|kilku)dzie\\p{L}*",
    "sto|stu|dwie[śs]cie|dwustu|trzyst[au]|czteryst[au]|(?:pi[ęe][ćc]|pi[ęe]ciu|sze[śs][ćc]|sze[śs]ciu|siedem|siedmiu|osiem|o[śs]miu|dziewi[ęe][ćc]|dziewi[ęe]ciu|kilka|kilku|par[ęe])set",
    // Not Tysiąclecia, a street.
    "(?!tysi[ąa]clec)tysi\\p{L}*|tys|ty[śs]|milion\\p{L}*|miliard\\p{L}*|mln|p[óo][łl]tor\\p{L}*",
    "st[óo]w\\p{L}*|stow[aeyk]\\p{L}*|setk\\p{L}*|setek|kafel\\p{L}*|kafl\\p{L}*|patyk\\p{L}*|patol\\p{L}*|dych\\p{L}*|dysz\\p{L}*|pi[ńn]cet\\p{L}*|piencet|ba[ńn]k[aiąeę]|baniek",
    // Not "ten", which is Polish for "this".
    "eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fourty|fifty|sixty|seventy|eighty|ninety|hundreds?|thousands?|grand|millions?|dozens?",
    "twice|thrice|dwukrotn\\p{L}*|trzykrotn\\p{L}*",
  ].join("|")})$`,
  "iu",
);
const SCALE_AFTER = /^(?:ko[łl][aoy]|k[óo][łl]|k|kk)$/iu;
const NUMERAL_JOIN = /^[\s,\-–—]*(?:(?:i|and|point|przecinek|comma)[\s,\-–—]+)?$/iu;
const COUNTED = /^(?:razy|times|x|po|rat\p{L}*|installments?)$/iu;
const AGAIN =
  /(?<![\p{L}])(?:drugie\s+tyle|jeszcze\s+raz\s+tyle|tyle\s+samo\s+jeszcze)(?![\p{L}])/giu;

/**
 * Any numeral from ten up, two numerals together ("six oh oh"), or a small one used as a count ("dwa
 * razy"). A numeral right after digits is part of that number ("1,5 tys.").
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
    if (
      /\d\s?$/.test(before) &&
      (THOUSANDS.test(cur.w) || HUNDREDS.test(cur.w) || MILLIONS.test(cur.w))
    )
      continue;
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
      /\d\s*(?:zł|zl|pln)?\.?\s*$/iu.test(before);
    if (/^oh$/i.test(cur.w) && phrase.length === 1) continue;
    for (const k of phrase) taken.add(k);
    if (!counts) continue;
    if (scaleNext && following) {
      for (const k of phrase.slice(0, -1)) out.push(words[k]?.w ?? "");
      out.push(`${last?.w} ${following.w}`);
      taken.add(lastAt + 1);
    } else for (const k of phrase) out.push(words[k]?.w ?? "");
  }
  for (const m of text.matchAll(AGAIN)) out.push(m[0]);
  return out;
}

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

const MINING =
  /(?<![\p{L}])(?:(?:kopa\p{L}*|kopa[łl]\p{L}*|wydobyw\p{L}*)\s+(?:krypto\p{L}*|bitcoin\p{L}*|btc|eth|ethereum)|(?:crypto|bitcoin|btc|eth|ethereum)\s+mining|mining\s+(?:crypto\p{L}*|bitcoin|btc|eth|ethereum))(?![\p{L}])/giu;

export function paymentsIn(raw: string): { name: string; raw: string }[] {
  const text = plain(raw);
  return PAYMENTS.flatMap((p) => {
    const m = p.re.exec(text);
    return m ? [{ name: p.name, raw: m[0] }] : [];
  });
}

const PICKUP =
  /(?<![\p{L}])(?:odbi[óo]r\p{L}*|odbier\p{L}*|odebra\p{L}*|osobi[śs]cie|spotka\p{L}*|podjad\p{L}*|podjech\p{L}*|przyjad\p{L}*|przyjech\p{L}*|wpa[śs][ćc]|wpadn\p{L}*|przyj[śs][ćc]|przyjd[eę]|przyjdziemy|podej[śs][ćc]|podejd[eę]|zgarn\p{L}*|dojad[eę]|dojecha[ćc]|dojedziemy|zabior[eę]|zabra[ćc]|zabierzemy|pick(?:\s+\p{L}+)?(?:\s|-)?up|collect\p{L}*|in\s+person|meet\p{L}*|podskocz\p{L}*|skocz[ęe]\s+po|pojad[ęe]\s+do|b[ęe]d[ęe]\s+u\s+(?:pana|pani|ciebie|was|pa[ńn]stwa)|u\s+(?:pana|pani|ciebie|pa[ńn]stwa)(?=\s*[?.!,]|\s*$)|z\s+r[ęe]ki\s+do\s+r[ęe]ki|come\s+(?:by|over|round|(?:and\s+)?get)|swing\s+by|drop\s+by|stop\s+by|grab\s+it|drive\s+over|hand\s*over|hand\s+it\s+over|(?:at|to)\s+your\s+(?:place|house|home))(?![\p{L}])/iu;
const MIDDLE =
  /(?<![\p{L}])(?:spotka\p{L}*\s+(?:si[ęe]\s+)?(?:w\s+po[łl]owie|po[śs]rodku|na\s+[śs]rodku)|meet\s+(?:you\s+)?(?:in\s+the\s+middle|halfway|half\s+way))(?![\p{L}])/giu;
/** "odbiorę w paczkomacie" collects a parcel. */
const PARCEL =
  /(?<![\p{L}])(?:paczk\p{L}*|paczkomat\p{L}*|przesy[łl]k\p{L}*|parcel\p{L}*|locker\p{L}*|kurier\p{L}*|courier\p{L}*)(?![\p{L}])/iu;
const IN_PERSON =
  /(?<![\p{L}])(?:osobi[śs]cie|osobist\p{L}*|in\s+person|spotka\p{L}*|meet\p{L}*|podjad\p{L}*|podjech\p{L}*|przyjad\p{L}*|przyjech\p{L}*|u\s+(?:pana|pani|ciebie|pa[ńn]stwa))(?![\p{L}])/iu;
const COLLECT =
  /(?<![\p{L}])(?:odbi[óo]r\p{L}*|odbier\p{L}*|odebra\p{L}*|collect\p{L}*|pick(?:\s+\p{L}+)?(?:\s|-)?up)(?![\p{L}])/giu;

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
const SHIPPING =
  /(?<![\p{L}])(?:wysy[łl]k\p{L}*|przesy[łl]k\p{L}*|kurier\p{L}*|paczkomat\p{L}*|paczk\p{L}*|inpost\p{L}*|dpd|dhl|gls|poczt\p{L}*|dostaw\p{L}*|wys[łl]a[ćc]|wy[śs]l\p{L}*|wysy[łl]a\p{L}*|prze[śs]l\p{L}*|przes[łl]a[ćc]|nada[ćc]|nadani\p{L}*|ship\p{L}*|deliver\p{L}*|courier\p{L}*|parcel\p{L}*|postage|post\s+it|send\s+it)(?![\p{L}])/iu;
/**
 * Only the owner can say something was paid or sent. Not as something to come ("zostanie wysłana") or
 * asked about in a sentence that opens with czy or kiedy.
 */
const PAID =
  /(?<![\p{L}])(?:(?:za|o|w|do|prze)?p[łl]aci[łl](?:em|am|[ae][śs]my|y[śs]my)|prze[łl]a[łl](?:em|am|[ae][śs]my)|wys[łl]a[łl](?:em|am|[ae][śs]my)|przes[łl]a[łl](?:em|am|[ae][śs]my)|nada[łl](?:em|am|[ae][śs]my)|(?<!(?:zostanie|zostan[ąa]|zosta[ćc]|b[ęe]dzie|b[ęe]d[ąa]|by[ćc]|(?:[żz]e|a)by\s+(?:by|zosta)[łl][aoy]?|kiedy|czy)\s+)(?<!(?:^|[.!?])\s*(?:czy|kiedy)(?![\p{L}])[^.!?,;]*)(?:(?:za|o|w)p[łl]acon\p{L}*|przelan[eaoy]|wys[łl]an[eaoy]|przes[łl]an[eaoy]|nadan[eaoy])|dokona[łl]\p{L}*\s+(?:\p{L}+\s+)?(?:p[łl]atno|zap[łl]at|przelew|wp[łl]at)\p{L}*|kupi[łl](?:em|am)\s+(?:ju[żz]|przez)|completed\s+(?:the\s+)?payment|payment\s+completed|(?:kasa|pieni[ąa]dze|[śs]rodki|money|funds)\s+(?:s[ąa]|jest|is|are)\s+(?:ju[żz]\s+|already\s+)?(?:u\s+(?:pana|pani|ciebie)|with\s+you|in\s+your\s+account|na\s+(?:pana|pani|twoim)\s+koncie)|(?:kasa|kas[eę]|pieni[ąa]dze|[śs]rodki|p[łl]atno[śs][ćc]|zap[łl]ata|wp[łl]ata|przelew|money|funds|payment|transfer)\s+(?:\p{L}+\s+)?(?:posz[łl]\p{L}*|poszed[łl]|wys[łl]an\p{L}*|wykonan\p{L}*|zrobion\p{L}*|zlecon\p{L}*|zrealizowan\p{L}*|zaksi[ęe]gowan\p{L}*|dotar[łl]\p{L}*|sent|done|made|complete\p{L}*|gone\s+through|went\s+through|on\s+(?:the|its)\s+way)|zrobi[łl](?:em|am)\s+przelew|uregulowa[łl]\p{L}*|pu[śs]ci[łl]\p{L}*|i(?:['’]ve|\s+have)?\s+(?:already\s+)?(?:paid|sent|transferred|wired|shipped|posted)|sent\s+(?:you|it|the\s+money|the\s+payment)|payment\s+(?:is\s+|has\s+been\s+|was\s+)?(?:sent|made|done|complete\p{L}*)|already\s+paid|(?<=^|[.!?]\s{0,3})paid)(?![\p{L}])/iu;

/** Sending an offer or a photo isn't a claim that something was paid or sent. */
const SENT_NOT_PAID =
  /(?<![\p{L}])(?:wys[łl]a|przes[łl]a|sent)\p{L}*\s+(?:panu\s+|pani\s+|you\s+|ci\s+)?(?:an?\s+|moj\p{L}*\s+|my\s+)?(?:propozycj|ofert|offer|wiadomo|zdj[ęe]|pytani|message|photo|question)\p{L}*/giu;

export function phonesIn(text: string): string[] {
  const digits = [...text.matchAll(/(?:\+|00)?\d(?:[^\p{L}\d]{0,3}\d){8,}/gu)]
    .map((m) => m[0])
    .filter((p) => p.replace(/\D/g, "").length <= 15);
  const spread = [
    ...text.matchAll(
      /(?<![\d.,])\d{3}(?![\d.,]\d|\d)(?:[^\d]{1,15}?(?<![\d.,])\d{3}(?![\d.,]\d|\d)){2}/gu,
    ),
  ]
    .map((m) => m[0])
    .filter((p) => !CURRENCY_BEFORE.test(p) && !/zł|zl|pln|€|\$/iu.test(p));
  return [...digits, ...spread];
}

const PROVIDERS =
  "g\\s?mail|wp|onet|o2|02|interia|yahoo|outlook|hotmail|icloud|proton(?:mail)?|op|gazeta|tlen|vp|poczta";
const EMAIL = /[\p{L}\p{N}._%+-]+\s?@\s?\p{L}[\p{L}\p{N}-]*(?:\.[\p{L}\p{N}-]+)*/giu;
const EMAIL_SPELT = new RegExp(
  `[\\p{L}\\p{N}._%+-]+\\s*(?:\\(at\\)|\\[at\\]|\\{at\\}|\\(małpa\\)|\\s+małpa\\s+|\\s+malpa\\s+|\\s+at\\s+(?=(?:${PROVIDERS})(?![\\p{L}])))\\s*[\\p{L}\\p{N}-]+\\s*(?:\\.|\\(dot\\)|\\[dot\\]|\\s+dot\\s+|\\s+kropka\\s+)\\s*\\p{L}{2,}`,
  "giu",
);
const EMAIL_HOST = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:${PROVIDERS})\\s*(?:[,]|\\s|kropka|dot)\\s*(?:com|pl|net|eu|me)(?![\\p{L}])`,
  "giu",
);
const EMAIL_AT_PROVIDER =
  /[\p{L}\p{N}._-]{3,}\s+na\s+(?:wp|interi\p{L}*|onec\p{L}*|onet\p{L}*|gmail\p{L}*|o2|outlook\p{L}*|yahoo|hotmail\p{L}*|poczcie)(?![\p{L}])/iu;
const EMAIL_WORD =
  /(?<![\p{L}])(?:e-?mail\p{L}*|mail[aeu]|mailem|mejl\p{L}*|g\s?mail\p{L}*)(?![\p{L}])/iu;
const NOT_STREETS = new Set(
  "stan ocena kondycja bateria wygląd wyglad gwarancja wersja rozmiar model rating condition battery size version odbiór odbior termin data dnia pan pana pani panu panem państwa panstwa mogę moge ostatecznie najniżej najnizej najwięcej najwiecej".split(
    " ",
  ),
);
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
  { re: /(?<![\p{L}])[Aa]dres\p{Ll}*\s*:?\s*(?:\p{Lu}\p{Ll}+\s+){1,3}\d{1,4}/gu },
  {
    re: /(\p{Lu}\p{Ll}+)(?:\s+\p{Lu}\p{Ll}+)?\s+\d{1,4}[a-zA-Z]?\s*(?:\/\s*\d{1,4}[a-zA-Z]?|(?:m|lok|apt|flat)\.?\s*\d{1,4})(?!\d)/gu,
    street: 1,
  },
  {
    re: /(\p{Lu}\p{Ll}+)\s+\d{1,3}[a-zA-Z]?,\s*(\p{Lu}\p{Ll}{2,})(?![\p{L}])/gu,
    street: 1,
    city: 2,
  },
  { re: /(\p{Lu}\p{Ll}+)\s+\d{1,3}[a-zA-Z]?\s+w\s+\p{Lu}\p{Ll}{2,}/gu, street: 1 },
  {
    re: /(?<![\p{L}])w\s+\p{Lu}\p{Ll}{2,}\s*,\s+(\p{Lu}\p{Ll}+)\s+\d{1,3}[a-zA-Z]?(?![\d.,:])/gu,
    street: 1,
  },
  {
    re: /(?<![\p{L}])(?:na|przy)\s+(\p{Lu}\p{Ll}+)\s+\d{1,4}[a-zA-Z]?(?![\p{N}/.,:]|\s*(?:zł|zl|pln|k|tys)(?![\p{L}]))/gu,
    street: 1,
  },
];
const APPS =
  /(?<![\p{L}])(?:whats\s?app\p{L}*|wh?ats?\s?up|[łlw]h?[ao](?:ts|c|s)ap+\p{L}*|wa\.me|telegram\p{L}*|t\.me|signal\p{L}*|viber\p{L}*|messenger\p{L}*|facebook\p{L}*|fb\.com|fejs\p{L}*|instagram\p{L}*|insta\p{L}*|snap\p{L}*|whatsik\p{L}*|whats-app\p{L}*|wechat|discord\p{L}*|skype\p{L}*|threema|sms\p{L}*|esem\p{L}*|imessage)(?![\p{L}])/iu;
/** A carrier's SMS isn't another app: "kod odbioru dostanie Pan SMS-em od InPost". */
const SMS = /(?<![\p{L}])(?:sms|esem)\p{L}*/giu;
const CARRIER =
  /(?<![\p{L}])(?:inpost\p{L}*|paczkomat\p{L}*|paczk\p{L}*|przesy[łl]k\p{L}*|kurier\p{L}*|dpd|dhl|gls|poczt\p{L}*|orlen\p{L}*|kod\p{L}*\s+odbioru)(?![\p{L}])/iu;
/** On their own, not in Wa-wa or a domain. */
const APP_SHORT =
  /(?<![\p{L}\p{N}.@-])(?:wa|tg|fb|ig|snap)(?![\p{L}\p{N}-])|(?<![\p{L}])na\s+tele(?![\p{L}])/iu;

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
  const apps = text
    .split(/(?<=[.!?\n])/)
    .map((s) => (CARRIER.test(s) ? s.replace(SMS, " ") : s))
    .join("");
  const app = APPS.exec(apps)?.[0] ?? APP_SHORT.exec(text)?.[0];
  if (app) out.push({ kind: "apps", raw: app });
  return out;
}

/** A spaced-out dot before these is a host's dot even with nothing after it. */
const TLDS =
  "pl|com|net|org|eu|io|me|ly|info|app|xyz|shop|link|co|online|top|site|store|club|biz|cc|tk|ml|ga|cf|gq|icu|live|vip|win|fun|space|website|tech|pro|ru|cn|de|cz|uk|us";
/** Dots and schemes written so a filter misses them: olx[.]pl, olx (dot) pl, hxxps://. */
const undefang = (s: string) =>
  s
    .replace(/\s*[[({<]\s*(?:\.|dot|kropka)\s*[\])}>]\s*/giu, ".")
    .replace(/\s+(?:dot|kropka)\s+(?=[\p{L}\p{N}])/giu, ".")
    .replace(
      /([\p{L}\p{N}-]+)\s*\.\s+((?:\p{L}{2,24}|xn--[a-z0-9-]+))(?=([/:])|(?![\p{L}\p{N}-]))/giu,
      (all, host: string, tld: string, path: string | undefined) =>
        path || host.includes("-") || new RegExp(`^(?:${TLDS})$`, "i").test(tld)
          ? `${host}.${tld}`
          : all,
    )
    .replace(new RegExp(`([\\p{L}\\p{N}-]+)\\s?,\\s?(${TLDS})(?=[/:])`, "giu"), "$1.$2")
    // evil .co: a space before a dot and none after isn't how a sentence ends.
    .replace(/([\p{L}\p{N}-]+)\s+\.(?=(?:\p{L}{2,24}|xn--[a-z0-9-]+)(?![\p{L}\p{N}-]))/giu, "$1.")
    .replace(/h(?:tt|xx|\*\*)p(s?)\s*(?:\[:\]|\(:\)|:)?\s*\/\//giu, "http$1://");
const LINK =
  /(?:https?|ftp):\/\/\S+|www\.\S+|(?<![\p{N}.])(?:\d{1,3}\.){3}\d{1,3}(?![\p{N}]|\.\d)(?::\d{2,5})?(?:\/\S*)?|(?<![\p{L}\p{N}@._-])((?:[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?\.)+)(?:\p{L}{2,24}|xn--[a-z0-9-]{2,59})(?![\p{L}\p{N}-])(?::\d{2,5})?(?:\/\S*)?/giu;
/** A sentence can run into these without a space: "np.zdjęcie", "tys.zł". */
const ABBREVIATIONS = new Set(
  "np ok tzn itd itp tj ul al os pl nr godz tys zł zl r m św sw dr mgr inż inz prof ds pt jw wg ww tel ps kpl szt min max st".split(
    " ",
  ),
);

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
