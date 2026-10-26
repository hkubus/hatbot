// negotiate_send's policy, one rule at a time: a case it must hold and a near miss that
// must go. The check fails closed, so the near misses are what keep it usable.
import { describe, expect, test } from "bun:test";
import type { Negotiation, NegotiationMessage } from "@hatbot/shared";
import {
  allowance,
  amountsIn,
  contactsIn,
  linksIn,
  NEW_PER_DAY,
  numberWords,
  type SendFacts,
  type SendInput,
  sendPolicy,
  stalled,
} from "../src/negotiate/policy";

const NOW = Date.parse("2026-10-09T12:00:00Z");
const TITLE = "Karta graficzna RTX 3070 8GB Gigabyte Gaming OC";

const negotiation = (over: Partial<Negotiation> = {}): Negotiation => ({
  id: 7,
  botId: "haggler",
  wantId: 1,
  want: "RTX 3070",
  role: "buy",
  listingKey: "OLX:1001",
  listingUrl: "https://www.olx.pl/d/oferta/karta-rtx-3070-CID99-ID1001.html",
  title: TITLE,
  // At the ceiling: a message needn't name a price to go. Tests with a seller past it say so.
  asking: 1400,
  mandate: {
    currency: "PLN",
    opening: 1060,
    target: 1250,
    limit: 1400,
    delivery: "OLX delivery",
    expiresAt: "2026-10-16T12:00:00.000Z",
    allow: [],
  },
  appraisal: null,
  conversationUrl: null,
  claims: { max: null, otherOffers: null, timing: null, other: [] },
  status: "open",
  agreedPrice: null,
  approvalId: null,
  conversationId: 1,
  nextFollowUpAt: null,
  lastMessage: null,
  createdAt: "2026-10-09T11:00:00.000Z",
  updatedAt: "2026-10-09T11:00:00.000Z",
  closedAt: null,
  ...over,
});
/** Selling: the floor is 1,000 zł. */
const selling = (over: Partial<Negotiation> = {}) =>
  negotiation({
    role: "sell",
    mandate: { ...negotiation().mandate, opening: 1300, target: 1150, limit: 1000 },
    ...over,
  });
const delivering = (delivery: string) =>
  negotiation({ mandate: { ...negotiation().mandate, delivery } });
const pickupToo = delivering("OLX delivery, or pickup in Warsaw");
const allowsAll = negotiation({
  mandate: { ...negotiation().mandate, allow: ["phone", "email", "address", "apps"] },
});

const facts = (over: Partial<SendFacts> = {}): SendFacts => ({
  now: NOW,
  hour: 14,
  inFlight: false,
  starts: false,
  startedToday: 0,
  dealtElsewhere: null,
  unansweredSince: null,
  seller: [],
  ...over,
});
/** The seller's messages, oldest first, each marked whether it came after our last one. */
const said = (...texts: [string, boolean][]) =>
  facts({ seller: texts.map(([text, after]) => ({ text, after })) });
const sellerSaid = (text: string) => said([text, true]);
const msg = (text: string, over: Partial<SendInput> = {}): SendInput => ({
  text,
  offer: null,
  agree: false,
  stated: null,
  ...over,
});
const verdict = (text: string, input: Partial<SendInput> = {}, n = negotiation(), f = facts()) =>
  sendPolicy(n, msg(text, input), f);
const act = (text: string, input: Partial<SendInput> = {}, n = negotiation(), f = facts()) =>
  verdict(text, input, n, f).action;
const why = (v: ReturnType<typeof sendPolicy>) => ("why" in v ? v.why : "");
const kinds = (text: string) => contactsIn(text).map((c) => c.kind);

describe("what can't go at all", () => {
  test("nothing goes before the mandate is approved, once it's closed, mid-send, or off the listing's site", () => {
    const blocked: [Negotiation, SendFacts][] = [
      [negotiation({ status: "awaiting_mandate" }), facts()],
      [negotiation({ status: "agreed" }), facts()],
      [negotiation(), facts({ inFlight: true })],
      [negotiation({ conversationUrl: "https://olx-chat.example/c/1" }), facts()],
    ];
    for (const [n, f] of blocked) expect(act("Dam 1100 zł.", { offer: 1100 }, n, f)).toBe("block");
    const same = negotiation({ conversationUrl: "https://olx.pl/myaccount/answers/555" });
    expect(act("Dam 1100 zł.", { offer: 1100 }, same)).toBe("allow");
  });

  test("agreeing needs its price in offer: agree without one, or words that accept, can't go", () => {
    expect(act("Ok, biorę za 1300.", { agree: true })).toBe("block");
    expect(why(verdict("Ok, biorę."))).toContain('"biorę"');
    expect(why(verdict("I'll take it."))).toContain('"I\'ll take it"');
    // A question about the item, or a condition with our price, isn't accepting.
    expect(act("Pasuje Panu jutro?")).toBe("allow");
    expect(act("Is it a good deal?")).toBe("allow");
    expect(act("Biorę, jeśli zejdzie Pan do 1100.", { offer: 1100 })).toBe("allow");
  });
});

describe("pace limits and quiet hours", () => {
  test("nothing goes between 22:00 and 08:00, asked or not", () => {
    for (const hour of [22, 7]) {
      expect(act("Dam 1100 zł.", { offer: 1100 }, negotiation(), facts({ hour }))).toBe("block");
      expect(act("Dam 1500 zł.", {}, negotiation(), facts({ hour }))).toBe("block");
    }
    for (const hour of [8, 21])
      expect(act("Dam 1100 zł.", { offer: 1100 }, negotiation(), facts({ hour }))).toBe("allow");
  });

  test("an account starts only so many conversations a day; replies in old ones still go", () => {
    const starting = (startedToday: number) => facts({ starts: true, startedToday });
    expect(act("Dzień dobry", {}, negotiation(), starting(NEW_PER_DAY))).toBe("block");
    expect(act("Dzień dobry", {}, negotiation(), starting(NEW_PER_DAY - 1))).toBe("allow");
    expect(act("Dzień dobry", {}, negotiation(), facts({ startedToday: 30 }))).toBe("allow");
  });

  test("two messages in a row are two minutes apart unless the seller answered", () => {
    const since = (ms: number) => facts({ unansweredSince: NOW - ms });
    expect(act("Halo?", {}, negotiation(), since(60_000))).toBe("block");
    expect(act("Halo?", {}, negotiation(), since(3 * 60_000))).toBe("allow");
  });
});

describe("the ceiling and the floor", () => {
  test("buying: an offer or a stated most above the ceiling asks; at the ceiling goes", () => {
    expect(act("Mogę trochę podnieść ofertę.", { offer: 1450 })).toBe("ask");
    expect(act("Więcej nie dam.", { stated: { max: 1500 } })).toBe("ask");
    expect(act("Dam 1.400 zł i to moje ostatnie słowo.", { offer: 1400 })).toBe("allow");
    expect(act("Najwięcej mogę dać 1350 zł.", { stated: { max: 1350 } })).toBe("allow");
  });

  test("selling: below the floor asks, in the offer, in the text or in the buyer's price agreed to", () => {
    expect(act("Mogę zejść do 950 zł.", { offer: 950 }, selling())).toBe("ask");
    expect(act("Mogę 900 zł.", {}, selling())).toBe("ask");
    const agree = { agree: true, offer: 1000 };
    expect(
      act("Zgoda, 1000 zł.", agree, selling(), sellerSaid("Mogę dać 900, najwyżej 1000.")),
    ).toBe("ask");
    expect(act("Mogę zejść do 1000 zł.", { offer: 1000 }, selling())).toBe("allow");
    expect(act("Zgoda, 1000 zł.", agree, selling(), sellerSaid("Dam 1000 zł."))).toBe("allow");
  });
});

describe("an amount in the text counts, however it's written", () => {
  test("every reading of a number's separators counts, whatever the offer says", () => {
    expect(amountsIn("1.500", "")).toEqual([{ raw: "1.500", values: [1500, 1.5] }]);
    expect(amountsIn("1 400,50 zł", "")).toEqual([{ raw: "1 400,50", values: [1400.5] }]);
    expect(why(verdict("Dam 1 500 zł.", { offer: 1100 }))).toContain('"1 500"');
    // "Mogę 1,5": thousands without the k. Grosze after zł are what they say.
    expect(act("Mogę 1,5.", { offer: 1100 })).toBe("ask");
    expect(act("Dam 1 100 zł, paczkomat 9,99 zł.", { offer: 1100 })).toBe("allow");
  });

  test("slang and scale words after a number multiply it; 4K is a resolution", () => {
    expect(why(verdict("Dam 2 koła.", { offer: 1100 }))).toContain('"2 koła"');
    expect(why(verdict("I'll pay 15 hundred.", { offer: 1100 }))).toContain('"15 hundred"');
    expect(act("Jak sobie radzi w 4K?")).toBe("allow");
    expect(act("How does it handle 4K gaming?")).toBe("allow");
  });

  test("look-alike letters and other scripts' digits are read as the digits they show", () => {
    for (const text of ["Dam 15OO zł.", "Dam ١٥٠٠ zł."])
      expect(why(verdict(text, { offer: 1100 }))).toContain('"1500"');
  });

  test("digits spelt one by one, and groups or letters that make no one number, ask", () => {
    for (const raw of ["1 5 0 0", "15 00", "1k5"])
      expect(why(verdict(`Dam ${raw} zł.`, { offer: 1100 }))).toContain(`"${raw}"`);
    expect(act("Dam 1 100 zł.", { offer: 1100 })).toBe("allow");
  });

  test("a character outside plain letters, digits and punctuation asks; Polish letters don't", () => {
    expect(act("Dam 1100 zł 🙂", { offer: 1100 })).toBe("ask");
    expect(act("Dziękuję za szybką odpowiedź, mogę dać 1100 zł.", { offer: 1100 })).toBe("allow");
  });

  test("a word spelt letter by letter asks", () => {
    expect(why(verdict("Zapłacę B L I K"))).toContain('"B L I K"');
    expect(act("Czy jest m.in. pudełko i paragon?")).toBe("allow");
  });

  test("an amount in words asks, in Polish, English or slang; a count on its own doesn't", () => {
    expect(numberWords("Dam tysiąc czterysta pięćdziesiąt.")).toContain("tysiąc");
    expect(numberWords("I'd go fourteen hundred and fifty.")).toContain("hundred");
    expect(numberWords("Dam dwa koła.")).toEqual(["dwa koła"]);
    expect(act("Dam dwa koła.", { offer: 1100 })).toBe("ask");
    // A numeral right after digits is part of that number.
    expect(numberWords("Dam 1,5 tys. zł")).toEqual([]);
    expect(act("Karta ma dwa wentylatory?")).toBe("allow");
  });

  test("model numbers, units, dates, times and years aren't amounts; a bare number after w is", () => {
    for (const text of [
      "Czy karta to RTX 3070? Dam 1100 zł.",
      "Ma 8 GB, a zasilacz 650 W wystarczy?",
      "Mogę odebrać 15.10.2026 o 18:30.",
      "Kupiona w 2021 roku? Gwarancja do 2027 r.?",
      "Czy wystarczy do Ryzen 5 5600X?",
    ])
      expect(act(text, {}, pickupToo)).toBe("allow");
    expect(amountsIn("RTX3070 RX6800 i7-12700 16GB 3070ti", TITLE)).toEqual([]);
    expect(why(verdict("Zmieszczę się w 2000.", { offer: 1100 }))).toContain('"2000"');
  });

  test("the title's number is a model's only right after its word, and never after a price word", () => {
    const radeon = negotiation({ title: "AMD RX 6800 16GB" });
    expect(why(verdict("Mogę 6800.", {}, radeon))).toContain('"6800"');
    expect(act("Czy RX 6800 jest sprawna?", {}, radeon)).toBe("allow");
    expect(why(verdict("Czy to RTX 1600 czy RTX 3070?", { offer: 1100 }))).toContain('"1600"');
    const bike = negotiation({ title: "Rower Kross Hexagon 2000 cena 1800", asking: 1900 });
    expect(why(verdict("Biorę, cena 1800.", { offer: 1100 }, bike))).toContain('"1800"');
    expect(act("Czy Hexagon 2000 ma hamulce? Dam 1100.", { offer: 1100 }, bike)).toBe("allow");
  });

  test("letters glued to a number make it a model's only when they look like one, never ok or ca", () => {
    const cheap = negotiation({
      asking: 300,
      mandate: { ...negotiation().mandate, opening: 200, target: 250, limit: 300 },
    });
    for (const text of ["Mogę OK450.", "Mogę dać xy450.", "Dam za450."])
      expect(why(verdict(text, {}, cheap))).toContain("450");
    expect(act("Czy płyta b450 to obsłuży? Mogę 250.", { offer: 250 }, cheap)).toBe("allow");
  });
});

describe("amounts that together pass the ceiling, though each is under it", () => {
  test("every amount in our message adds up, whatever words stand between", () => {
    expect(act("Dam 1100+400.", { offer: 1100 })).toBe("ask");
    expect(act("Dam 1100 albo 1300 z wysyłką.", { offer: 1100 })).toBe("ask");
    expect(act("Dam 1100 albo 200.", { offer: 1100 })).toBe("allow");
  });

  test("a product past the ceiling asks; sizes and a model twice aren't products", () => {
    expect(act("Dam 2 x 750.")).toBe("ask");
    expect(act("Dam 2 razy po 750.")).toBe("ask");
    for (const text of [
      "Czy wymiary to 30x40 cm? Dam 1100.",
      "Czy RTX 3070 x 2 to ta sama karta? Dam 1100.",
    ])
      expect(act(text, { offer: 1100 })).toBe("allow");
  });

  test("a price each asks, since the total depends on how many; po before an hour doesn't", () => {
    expect(act("Dam 700 zł za sztukę.")).toBe("ask");
    expect(act("I'll pay 700 each.")).toBe("ask");
    expect(act("Gdzie w Warszawie byłby odbiór? Mogę podjechać po 17.", {}, pickupToo)).toBe(
      "allow",
    );
  });

  test("a price for more than one item asks: the mandate covers this listing", () => {
    expect(act("Dam 1100 zł za obie.", { offer: 1100 })).toBe("ask");
    expect(act("Czy oba wentylatory działają?")).toBe("allow");
  });

  test("shipping counts on top only as the delivery terms allow, at most a tenth of the limit", () => {
    expect(allowance("OLX delivery, up to 100 zł on top", 1400)).toBe(100);
    expect(allowance("Wysyłka OLX, dopłata do 20 zł za wysyłkę", 1100)).toBe(20);
    expect(allowance("OLX delivery, up to 300 zł on top", 1400)).toBe(140);
    expect(allowance("OLX delivery, 1400 zł total including shipping", 1100)).toBe(0);
    expect(allowance("Wysyłka OLX, maks. 1450 zł łącznie z dopłatą za wysyłkę", 1100)).toBe(0);
    const extra = delivering("OLX delivery, up to 100 zł on top");
    expect(act("Dam 1380 + 50 zł za wysyłkę.", { offer: 1380 })).toBe("ask");
    expect(act("Dam 1380 + 50 zł za wysyłkę.", { offer: 1380 }, extra)).toBe("allow");
    expect(act("Dam 1380 + 150 zł za wysyłkę.", { offer: 1380 }, extra)).toBe("ask");
  });
});

describe("amounts set by another one, or left open", () => {
  test("a share, or an amount on top of the seller's price, asks; working 100% doesn't", () => {
    expect(act("Dołożę 500 zł do Pana ceny.")).toBe("ask");
    expect(act("I'll pay 50% more.")).toBe("ask");
    expect(act("Czy działa w 100%?")).toBe("allow");
  });

  test("part of the price left open asks: the rest later, or shipping on top with no amount", () => {
    expect(act("Dam 1000 zł, a różnicę dopłacę za tydzień.", { offer: 1000 })).toBe("ask");
    expect(act("I'll pay 1000 now and the rest next week.", { offer: 1000 })).toBe("ask");
    expect(act("Dam 1000 zł + wysyłka.", { offer: 1000 })).toBe("ask");
    expect(act("Dam 1000 zł + wysyłka 20 zł.", { offer: 1000 })).toBe("allow");
    expect(act("Czy reszta zestawu jest w pudełku?")).toBe("allow");
  });
});

describe("agreeing agrees to the other side's price, so that's what's checked", () => {
  const yes = (text: string, offer: number, f: SendFacts, n = negotiation()) =>
    act(text, { agree: true, offer }, n, f);

  test("their price is the most they named since our last message, else their last, else the asking price", () => {
    expect(yes("Zgoda, 1300 zł.", 1300, sellerSaid("Ostatecznie 1500 zł."))).toBe("ask");
    const twice = said(["Ostatecznie 1450 zł.", true], ["Ewentualnie 1300.", true]);
    expect(yes("Zgoda, 1300 zł.", 1300, twice)).toBe("ask");
    expect(yes("Zgoda, 1300 zł.", 1300, sellerSaid("1300 + 150 za wysyłkę."))).toBe("ask");
    const asks1500 = negotiation({ asking: 1500 });
    expect(yes("Zgoda, 1300 zł.", 1300, facts(), asks1500)).toBe("ask");
    // "Cena jak w ogłoszeniu" takes an earlier price back: the asking price again.
    const retracted = said(
      ["Mogę zejść do 1300 zł.", false],
      ["Jednak zmieniłem zdanie, cena jak w ogłoszeniu.", true],
    );
    expect(yes("Zgoda, 1300 zł.", 1300, retracted, asks1500)).toBe("ask");
    expect(yes("Ok, biorę za 1300 zł.", 1300, sellerSaid("Mogę zejść do 1300."))).toBe("allow");
    const earlier = said(["Cena 1350, nie mniej.", false], ["Dobrze, to jak?", true]);
    expect(yes("Zgoda, 1350 zł.", 1350, earlier)).toBe("allow");
    expect(yes("Deal at 1200.", 1200, sellerSaid("I can do 1200."))).toBe("allow");
  });

  test("a yes that doesn't name its price asks, whatever number the seller's message holds", () => {
    expect(yes("Zgoda.", 1000, sellerSaid("Za 1000 nie sprzedam."))).toBe("ask");
    expect(yes("Deal.", 1000, sellerSaid("No way, 1000 is too low."))).toBe("ask");
    expect(act("Ok.", {}, negotiation(), sellerSaid("Mogę zejść do 1000 zł."))).toBe("ask");
    expect(yes("Zgoda, 1000 zł.", 1000, sellerSaid("Mogę zejść do 1000 zł."))).toBe("allow");
  });

  test("a seller's price that can't be read asks", () => {
    for (const seller of [
      "Dwa koła i jest Pana.",
      "Po 700 za sztukę.",
      "300 EUR.",
      "Ostatecznie 1️⃣3️⃣0️⃣0️⃣ zł.",
      "1000 zł + wysyłka",
    ])
      expect(yes("Zgoda, 1300 zł.", 1300, sellerSaid(seller))).toBe("ask");
    expect(yes("Świetnie, biorę za 1300 zł.", 1300, sellerSaid("Mogę zejść do 1300 zł 👍"))).toBe(
      "allow",
    );
  });

  test("while their price is past the ceiling, only a message naming our price, and not agreeing, goes", () => {
    const past = sellerSaid("Najniżej 1600");
    const ours = (text: string, f = past) => act(text, { offer: 1300 }, negotiation(), f);
    expect(act("Czy karta ma pudełko?", {}, negotiation(), past)).toBe("ask");
    expect(ours("Zapłacę pełną cenę, a nie 1300 zł.")).toBe("ask");
    expect(ours("I'll pay what you're asking, not 1300.")).toBe("ask");
    expect(ours("Dobrze, 1300 zł.")).toBe("ask");
    expect(ours("Dobrze, 1300 zł.", sellerSaid("Mogę zejść do 1300 zł."))).toBe("allow");
    expect(ours("Rozumiem. Mogę podnieść do 1300 zł, to moja ostatnia oferta.")).toBe("allow");
    expect(ours("Pana cena jest dla mnie za wysoka, mogę dać 1300 zł.")).toBe("allow");
  });
});

describe("another currency asks: its amounts can't be compared at face value", () => {
  test("a currency by word, sign or code asks; the mandate's own, and a shop called Euro, don't", () => {
    for (const text of ["Dam 300 EUR.", "I'll pay $350.", "Dam 300 CAD."])
      expect(act(text)).toBe("ask");
    expect(act("Dam 1100 PLN.", { offer: 1100 })).toBe("allow");
    expect(act("Czy paragon z Euro RTV AGD?")).toBe("allow");
    const euro = negotiation({
      mandate: { ...negotiation().mandate, currency: "EUR", limit: 400 },
    });
    expect(act("Dam 300 EUR.", { offer: 300 }, euro)).toBe("allow");
    expect(act("Dam 300 zł.", { offer: 300 }, euro)).toBe("ask");
  });
});

describe("ways to pay, delivery and saying we've paid", () => {
  test("a way to pay the terms don't name asks, off the platform too; a card's mining past doesn't", () => {
    for (const text of [
      "Mogę zapłacić BLIKiem.",
      "Can I pay cash?",
      "Mogę zapłacić poza OLX.",
      "Can I pay you directly?",
    ])
      expect(act(text)).toBe("ask");
    expect(act("Czy karta była używana do kopania kryptowalut?")).toBe("allow");
  });

  test("a way to pay goes when a clause of the terms names it, not when one rules it out", () => {
    const cash = delivering("Pickup in Warsaw, cash on the spot");
    expect(act("Zapłacę gotówką przy odbiorze.", {}, cash)).toBe("allow");
    expect(act("Zapłacę BLIKiem przy odbiorze.", {}, cash)).toBe("ask");
    expect(act("Może być BLIK?", {}, delivering("OLX delivery or BLIK"))).toBe("allow");
    expect(act("Może być BLIK?", {}, delivering("OLX delivery only; no BLIK"))).toBe("ask");
    expect(act("Może być BLIK?", {}, delivering("Tylko OLX Przesyłka, bez BLIK-a"))).toBe("ask");
  });

  test("pickup asks unless the terms allow it; haggling and collecting a parcel aren't pickup", () => {
    for (const text of ["Mogę odebrać osobiście jutro.", "Can I pick it up today?"]) {
      expect(act(text)).toBe("ask");
      expect(act(text, {}, pickupToo)).toBe("allow");
      expect(act(text, {}, delivering("OLX delivery only, no pickup"))).toBe("ask");
    }
    expect(act("Spotkajmy się w połowie: 1350 zł?", { offer: 1350 })).toBe("allow");
    expect(act("Czy paczkę odbiorę w paczkomacie przy domu?")).toBe("allow");
  });

  test("shipping asks when the terms are pickup only", () => {
    const pickupOnly = delivering("Odbiór osobisty w Warszawie");
    for (const text of ["Może Pan wysłać paczkomatem?", "Can you ship it?"]) {
      expect(act(text, {}, pickupOnly)).toBe("ask");
      expect(act(text)).toBe("allow");
    }
    expect(act("Mogę odebrać jutro.", {}, pickupOnly)).toBe("allow");
  });

  test("saying something was paid or sent asks, whatever the mandate allows; asking whether it was doesn't", () => {
    const all = negotiation({
      mandate: { ...allowsAll.mandate, delivery: "OLX delivery, bank transfer or a deposit" },
    });
    for (const text of ["Zapłaciłem już.", "I've paid.", "Paczka została wysłana."])
      expect(act(text, {}, all)).toBe("ask");
    for (const text of [
      "Czy paczka została nadana?",
      "Wolałbym, żeby była wysłana kurierem przez OLX.",
      "Wysłałem Panu propozycję 1200 zł przez OLX.",
    ])
      expect(act(text)).toBe("allow");
  });
});

describe("contact details and links", () => {
  test("a phone number asks unless the mandate allows phones, however its groups are joined", () => {
    for (const text of [
      "Mój numer: 600 700 800.",
      "Mój numer: 600 i 100 i 200",
      "Zadzwoń 6OO 7OO 8OO",
    ])
      expect(kinds(text)).toContain("phone");
    expect(act("Mój numer: 600 700 800.")).toBe("ask");
    const phones = negotiation({ mandate: { ...negotiation().mandate, allow: ["phone"] } });
    expect(act("Mój numer: 600 700 800.", {}, phones)).toBe("allow");
    expect(contactsIn("Cena 1200 zł, 1300 zł albo 1250 zł.")).toEqual([]);
  });

  test("an e-mail address, written or spelt out, is one; at in a sentence isn't", () => {
    for (const text of [
      "Pisz na jan.kowalski@gmail.com",
      "jan małpa wp kropka pl",
      "Write to jan.kowalski (at) onet (dot) pl",
      "Napisz na maila",
    ])
      expect(kinds(text)).toContain("email");
    expect(contactsIn("Is it at its best? I'll pick it up at noon.")).toEqual([]);
  });

  test("a street address is one; ratings, dates and polite forms aren't", () => {
    for (const text of [
      "Adres: ul. Marszałkowska 10, Warszawa",
      "Mieszkam na Długiej 10",
      "Ship to 10 Downing Street please",
      "Kod pocztowy 00-950",
    ])
      expect(kinds(text)).toContain("address");
    for (const text of ["Stan 9/10?", "Odbiór 15/10 pasuje?", "Dam na Pana 1100 zł."])
      expect(contactsIn(text)).toEqual([]);
  });

  test("another app is one, by name, short name or sound; Wa-wa and a carrier's SMS aren't", () => {
    for (const text of ["Napisz na WhatsAppie", "Mam TG, pisz", "Pisz na łatsapie", "Wyślij SMS"])
      expect(kinds(text)).toContain("apps");
    for (const text of [
      "Odbiór Wa-wa.",
      "Wyślę jutro, a kod odbioru dostanie Pan SMS-em od InPost.",
    ])
      expect(contactsIn(text)).toEqual([]);
  });

  test("a link always asks, named whole however it's disguised; abbreviations and e-mail aren't links", () => {
    for (const [text, link] of [
      ["Zapłać tutaj: https://olx-pay.example/abc", "https://olx-pay.example/abc"],
      ["Zapłać na pay.olx.pl.evil.co/x", "pay.olx.pl.evil.co/x"],
      ["Zapłać na olx[.]pl.evil[.]co", "olx.pl.evil.co"],
      ["Wejdź hxxps://evil.example/pay", "https://evil.example/pay"],
      ["Wejdź na evil . co/pay", "evil.co/pay"],
    ] as const) {
      expect(linksIn(text)).toEqual([link]);
      expect(act(text, {}, allowsAll)).toBe("ask");
    }
    for (const text of [
      "Pisz: jan.kowalski (at) onet (dot) pl",
      "Np.zdjęcie z boku?",
      "Dam 1,5 tys.zł",
    ])
      expect(linksIn(text)).toEqual([]);
  });
});

describe("how it asks", () => {
  test("money outside the mandate, or a mandate that ran out, is approved in the app; a link or a phone number from the lock screen", () => {
    const ranOut = facts({ now: Date.parse("2026-10-20T12:00:00Z") });
    for (const v of [
      verdict("Dobrze, biorę za 2000 zł.", { offer: 2000, agree: true }),
      verdict("Mogę dać 1600 zł."),
      verdict("Dam 1100 zł.", { offer: 1100 }, negotiation(), ranOut),
    ])
      expect(v).toMatchObject({ action: "ask", kind: "purchase", careful: true });
    expect(verdict("Zdjęcia: https://imgur.com/a/x")).toMatchObject({
      action: "ask",
      kind: "send",
    });
    expect(verdict("Mój numer 600 100 200")).toMatchObject({ action: "ask", kind: "send" });
  });
});

/** Our offers and the seller's replies, alternating from ours, as recorded. */
const talk = (...turns: (number | string | null)[]): NegotiationMessage[] =>
  turns.map((x, i) => ({
    id: i + 1,
    negotiationId: 7,
    direction: i % 2 === 0 ? "out" : "in",
    text: typeof x === "string" ? x : `Mogę dać ${x} zł.`,
    offer: typeof x === "number" ? x : null,
    agree: false,
    stated: null,
    status: i % 2 === 0 ? "sent" : "received",
    taskId: null,
    createdAt: "2026-10-09T11:00:00.000Z",
    sentAt: null,
  }));

test("three offers the seller answers with the same price stall; a reply that names none doesn't count", () => {
  const n = negotiation({ asking: 1500 });
  expect(
    stalled(n, talk(1060, "1500 zł.", 1100, "Nie, 1500.", 1150, "Zostaję przy 1500 zł."), null),
  ).toBe(1500);
  // Taking our offer in words, or a question, isn't a price kept to.
  expect(
    stalled(n, talk(1060, "1500 zł.", 1100, "Nie, 1500.", 1150, "Dobra, niech będzie."), null),
  ).toBeNull();
  expect(stalled(n, talk(1060, "Aktualne.", null, "Po 17.", 1100, "1500 zł."), null)).toBeNull();
  // A seller who comes down at all, even beside the old price, has moved.
  expect(
    stalled(
      n,
      talk(1060, "1500 zł.", 1100, "Z 1500 zł mogę zejść na 1450 zł.", 1150, "1450 zł."),
      null,
    ),
  ).toBeNull();
  // Only rounds after the owner last decided count.
  expect(stalled(n, talk(1060, "1500 zł.", 1100, "Nie, 1500.", 1150, "1500 zł."), 3)).toBeNull();
});
