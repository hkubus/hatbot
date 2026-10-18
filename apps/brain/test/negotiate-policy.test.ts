// negotiate_send's policy, case by case (PLAN.md §16.3): what goes on its own, what asks, what can't go.
import { describe, expect, test } from "bun:test";
import type { Negotiation } from "@hatbot/shared";
import { mandateReason } from "../src/negotiate/mandate";
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
/** Delivery by OLX or pickup in person. */
const pickupToo = negotiation({
  mandate: { ...negotiation().mandate, delivery: "OLX delivery, or pickup in Warsaw" },
});

const facts = (over: Partial<SendFacts> = {}): SendFacts => ({
  now: NOW,
  hour: 14,
  inFlight: false,
  starts: false,
  startedToday: 0,
  unansweredSince: null,
  seller: [],
  ...over,
});
const msg = (text: string, over: Partial<SendInput> = {}): SendInput => ({
  text,
  offer: null,
  agree: false,
  stated: null,
  ...over,
});
const verdict = (text: string, input: Partial<SendInput> = {}, n = negotiation(), f = facts()) =>
  sendPolicy(n, msg(text, input), f);
const why = (v: ReturnType<typeof sendPolicy>) => ("why" in v ? v.why : "");

describe("inside the mandate, it goes without asking", () => {
  test.each([
    ["Dzień dobry, czy przyjmie Pan 1060 zł?", 1060],
    ["Mogę dać 1 250 zł, z wysyłką OLX.", 1250],
    ["Dam 1.400 zł i to moje ostatnie słowo.", 1400],
    ["Czy RTX 3070 jest sprawna? Dam 1200.", 1200],
    ["Would you take 1,300 PLN?", 1300],
    ["Hello, is it still available?", null],
  ])("%s", (text, offer) => {
    const v = verdict(text, { offer });
    expect(v).toEqual({ action: "allow", covered: "Within the mandate you approved" });
  });

  test("agreeing at the ceiling, and a stated max under it", () => {
    expect(verdict("OK, 1400 zł, biorę.", { offer: 1400, agree: true }).action).toBe("allow");
    expect(verdict("Więcej niż 1100 nie dam.", { offer: 1100, stated: { max: 1100 } }).action).toBe(
      "allow",
    );
  });

  test("model numbers, units, dates, times and years aren't amounts", () => {
    for (const text of [
      "Czy karta to RTX 3070? Dam 1100 zł.",
      "Ma 8 GB, a zasilacz 650 W wystarczy?",
      "Mogę odebrać 15.10.2026 o 18:30.",
      "Kupiona w 2021 roku? Gwarancja do 2027 r.?",
      "Gigabyte RTX 3070 Gaming OC, ok. 3 dni dostawy.",
      "Proszę o 2 sztuki zdjęć. Ile fps, 60 fps?",
    ])
      expect(verdict(text, {}, pickupToo)).toMatchObject({ action: "allow" });
  });
});

describe("an offer above the ceiling, or below the floor when selling, asks", () => {
  test("buying: above the ceiling", () => {
    const v = verdict("Mogę dać 1450 zł.", { offer: 1450 });
    expect(v).toMatchObject({ action: "ask", kind: "purchase", always: true });
    expect(why(v)).toContain("Offering 1,450 zł is above the ceiling of 1,400 zł.");
  });

  test("selling: below the floor; at it or above goes", () => {
    const v = verdict("Mogę zejść do 950 zł.", { offer: 950 }, selling());
    expect(why(v)).toContain("Offering 950 zł is below the floor of 1,000 zł.");
    expect(verdict("Mogę zejść do 1000 zł.", { offer: 1000 }, selling()).action).toBe("allow");
    expect(verdict("Najniżej 1 150 zł.", { offer: 1150 }, selling()).action).toBe("allow");
    // Selling, an amount in the text below the floor asks too.
    expect(why(verdict("Mogę 900 zł.", {}, selling()))).toContain('"900"');
  });

  test("a stated max above the ceiling asks", () => {
    const v = verdict("Maksymalnie mogę dać 1500.", { stated: { max: 1500 } });
    expect(why(v)).toContain("It tells the seller 1,500 zł is our most, above the ceiling");
  });

  test("an expired mandate asks for everything", () => {
    const n = negotiation({
      mandate: { ...negotiation().mandate, expiresAt: "2026-10-09T11:00:00Z" },
    });
    expect(why(verdict("Dam 1100 zł.", { offer: 1100 }, n))).toContain("The mandate ran out");
  });
});

describe("agree outside the mandate", () => {
  test("agreeing above the ceiling asks", () => {
    const v = verdict("Dobrze, 1500 zł, biorę.", { offer: 1500, agree: true });
    expect(v.action).toBe("ask");
    expect(why(v)).toContain("Agreeing to 1,500 zł is above the ceiling of 1,400 zł.");
  });

  test("agreeing below the floor asks when selling", () => {
    const v = verdict("Ok, 900 zł.", { offer: 900, agree: true }, selling());
    expect(why(v)).toContain("Agreeing to 900 zł is below the floor of 1,000 zł.");
  });

  test("agree without a price can't go", () => {
    expect(verdict("Ok, biorę.", { agree: true })).toEqual({
      action: "block",
      why: "Put the price you agree to in offer.",
    });
  });

  test("a low offer with the real figure in the text asks", () => {
    const v = verdict("Dam 1100... albo dobra, 1600 zł i biorę.", { offer: 1100, agree: true });
    expect(why(v)).toContain('The text says "1600"');
  });
});

describe("agreeing in words agrees to the seller's price, so that's what's checked", () => {
  const said = (...texts: [string, boolean][]) =>
    facts({ seller: texts.map(([text, after]) => ({ text, after })) });

  test.each([
    "Ok, biorę.",
    "Ok, biore.",
    "Wezmę.",
    "Deal.",
    "Niech będzie.",
    "Zgoda, umowa.",
    "Biorę za Pana cenę.",
    "Pasuje mi.",
    "Może być.",
    "Jesteśmy umówieni.",
    "I'll take it.",
    "Agreed, see you then.",
  ])("without agree or an offer, it can't go: %s", (text) => {
    const v = verdict(text);
    expect(v.action).toBe("block");
    expect(why(v)).toContain("It reads as accepting a price");
  });

  test("questions and conditions aren't agreeing", () => {
    for (const text of [
      "Czy pasuje do płyty B550?",
      "Pasuje Panu jutro?",
      "Może być problem z wysyłką?",
      "Is it a good deal?",
    ])
      expect(verdict(text).action).not.toBe("block");
    expect(verdict("Biorę, jeśli zejdzie Pan do 1100.", { offer: 1100 }).action).toBe("allow");
  });

  test("agreeing with no price in the text asks when the seller's price is past the ceiling", () => {
    // The model claims 1,100 zł, but "biorę" takes the seller's 1,500.
    const v = verdict(
      "Ok, biorę.",
      { agree: true, offer: 1100 },
      negotiation(),
      said(["Dzień dobry, ostatecznie 1500 zł.", true]),
    );
    expect(v.action).toBe("ask");
    expect(why(v)).toContain("the seller's last price, 1,500 zł, is above the ceiling of 1,400 zł");
    // Nothing from the seller: the asking price, 1,500 zł.
    const asks1500 = negotiation({ asking: 1500 });
    expect(why(verdict("Biorę za Pana cenę.", { agree: true, offer: 1100 }, asks1500))).toContain(
      "1,500 zł",
    );
    // The most they named since our last message counts, and their sums too.
    for (const text of ["1300 to za mało, 1450 ostatecznie.", "1350 + 100 za wysyłkę."])
      expect(
        verdict("Zgoda.", { agree: true, offer: 1300 }, negotiation(), said([text, true])).action,
      ).toBe("ask");
    // Agreeing in words with a price that isn't the offer: still the seller's price.
    expect(why(verdict("Zgoda, wysyłka 20 zł mi pasuje.", { offer: 1100 }, asks1500))).toContain(
      "It reads as agreeing, and the seller's last price, 1,500 zł",
    );
  });

  test("an agreement goes when it names its price and the seller's is inside the mandate", () => {
    expect(
      verdict(
        "Ok, biorę za 1300 zł.",
        { agree: true, offer: 1300 },
        negotiation(),
        said(["Mogę zejść do 1300.", true]),
      ).action,
    ).toBe("allow");
    // No new price since our last message: their latest one before it.
    expect(
      verdict(
        "Zgoda, 1350 zł.",
        { agree: true, offer: 1350 },
        negotiation(),
        said(["Cena 1350, nie mniej.", false], ["Dobrze, to jak?", true]),
      ).action,
    ).toBe("allow");
    expect(
      verdict(
        "Deal at 1200.",
        { agree: true, offer: 1200 },
        negotiation(),
        said(["I can do 1200.", true]),
      ).action,
    ).toBe("allow");
    expect(verdict("Biorę za 1300 zł.", { agree: true, offer: 1300 }).action).toBe("allow");
  });

  test("an agreement that doesn't name its price asks, whatever the seller's message seems to say", () => {
    // A number read from the seller isn't trusted for a bare yes: here it's the price they refused.
    for (const [text, seller] of [
      ["Zgoda.", "Za 1000 nie sprzedam."],
      ["Ok, biorę.", "Mogę zejść do 1300."],
      ["Deal.", "I can do 1200."],
      ["Ok.", "Cena bez zmian, wysyłka 15 zł."],
    ] as const)
      expect(
        why(verdict(text, { agree: true, offer: 1000 }, negotiation(), said([seller, true]))),
      ).toContain("doesn't name the price it agrees to");
  });

  test("a seller's price that can't be read asks", () => {
    for (const text of ["Dwa koła i jest Pana.", "Po 700 za sztukę.", "300 EUR.", "1 3 0 0"])
      expect(
        why(verdict("Zgoda.", { agree: true, offer: 1300 }, negotiation(), said([text, true]))),
      ).toContain("the seller's price can't be read");
  });

  test("selling, the buyer's price below the floor asks", () => {
    const v = verdict(
      "Zgoda.",
      { agree: true, offer: 1000 },
      selling(),
      said(["Dam 900 i odbieram dziś.", true]),
    );
    expect(why(v)).toContain("the buyer's last price, 900 zł, is below the floor of 1,000 zł");
  });
});

describe("an amount written in the text, however it's written", () => {
  test.each([
    ["Dam 1500.", "1500"],
    ["Dam 1 500 zł.", "1 500"],
    ["Dam 1.500 zł.", "1.500"],
    ["Dam 1,500 zł.", "1,500"],
    ["Dam 1'500.", "1'500"],
    ["Dam 1.500,00 zł.", "1.500,00"],
    ["Dam 1 500,50 zł.", "1 500,50"],
    ["Dam 1,5k.", "1,5k"],
    ["Dam 1.5 tys.", "1.5 tys."],
    ["Dam 2 tysiące.", "2 tysiące"],
    ["I'll pay 1.6 grand.", "1.6 grand"],
    ["Dam PLN 1600.", "1600"],
    ["Dam 1600zł.", "1600"],
    ["2000 w gotówce od ręki.", "2000"],
    ["Dam 1450, 1500 max.", "1450"],
    ["Za kartę 1600 min. to moja cena.", "1600"],
    ["Model z 2000? Dam 2000.", "2000"],
  ])("%s", (text, raw) => {
    const v = verdict(text, { offer: 1100 });
    expect(v.action).toBe("ask");
    expect(why(v)).toContain(`"${raw}"`);
  });

  test.each([
    ["Dam tysiąc czterysta pięćdziesiąt.", "tysiąc"],
    ["Dam czternaście stów.", "stów"],
    ["Dam półtora patyka.", "patyka"],
    ["Dam dwa kafle.", "kafle"],
    ["I'd go fourteen hundred and fifty.", "hundred"],
    ["Dam pięćset za samą kartę.", "pięćset"],
  ])("written in words: %s", (text, word) => {
    const v = verdict(text, { offer: 1100 });
    expect(why(v)).toContain("in words");
    expect(why(v)).toContain(`"${word}"`);
  });

  test.each([
    ["Dam 2 koła.", "2 koła"],
    ["Dam 2 kafle.", "2 kafle"],
    ["Dam 3 kafel.", "3 kafel"],
    ["Dam 2 tysiaki.", "2 tysiaki"],
    ["Dam 1,5 tysiąca.", "1,5 tysiąca"],
    ["Dam 15 stów.", "15 stów"],
    ["Dam 15 stówek.", "15 stówek"],
    ["Dam 15 setek.", "15 setek"],
    ["I'll pay 15 hundred.", "15 hundred"],
    ["Dam 2k.", "2k"],
    ["Zmieszczę się w 2000.", "2000"],
    ["Dam z 2000, od 2000 nie zejdę.", "2000"],
    ["Dam zł1500.", "1500"],
    ["Dam 15OO zł.", "1500"],
    ["Dam l500.", "1500"],
    ["Dam I5OO.", "1500"],
    ["Dam 15ОО (Cyrillic O).", "1500"],
    ["Dam １５００ zł.", "1500"],
    ["Dam ١٥٠٠ zł.", "1500"],
    ["Dam ۱۵۰۰ zł.", "1500"],
    ["Dam १५०० zł.", "1500"],
    ["Dam 1­500 zł.", "1500"],
    ["Dam 1​500 zł.", "1500"],
    ["Dam 1 500 zł.", "1 500"],
    ["Dam 1’500 zł.", "1’500"],
  ])("slang, look-alike and other scripts' digits: %s", (text, raw) => {
    const v = verdict(text, { offer: 1100 });
    expect(v.action).toBe("ask");
    expect(why(v)).toContain(`"${raw}"`);
  });

  test.each([
    ["Dam dwa koła.", "dwa koła"],
    ["Dam półtora koła.", "półtora koła"],
    ["Dam półtora tysiaca.", "tysiaca"],
    ["Dam pińcet.", "pińcet"],
    ["Dam tysiaka.", "tysiaka"],
    ["Dam dwie dyszki.", "dyszki"],
  ])("slang in words asks: %s", (text, word) => {
    const v = verdict(text, { offer: 1100 });
    expect(why(v)).toContain("in words");
    expect(why(v)).toContain(`"${word}"`);
  });

  test("digits written one by one ask", () => {
    for (const text of ["Dam 1 5 0 0 zł.", "Dam 1-5-0-0.", "Dam 1.5.0.0"])
      expect(why(verdict(text, { offer: 1100 }))).toContain("digit by digit");
    expect(verdict("Dam 1 100 zł.", { offer: 1100 }).action).toBe("allow");
  });

  test("a price in the listing's title doesn't make our number a model number", () => {
    const phone = negotiation({ title: "iPhone 12 128GB cena 1500", asking: 1500 });
    for (const text of ["Ok, biorę za 1500.", "Ok, biorę, cena 1500.", "Biorę, iPhone 1500."])
      expect(why(verdict(text, { offer: 1100 }, phone))).toContain('"1500"');
    expect(verdict("Czy iPhone 12 ma 128GB? Dam 1100.", { offer: 1100 }, phone).action).toBe(
      "allow",
    );
    // Our RTX listing asks 1,500 zł.
    for (const [text, raw] of [
      ["Biorę za RTX 1500.", "1500"],
      ["Biorę za RTX1500.", "1500"],
      ["Biorę za RTX 1450.", "1450"],
      ["Czy to RTX 1500?", "1500"],
      ["Dam za1500.", "1500"],
      ["Dam1500.", "1500"],
    ])
      expect(why(verdict(text ?? "", { offer: 1100 }))).toContain(`"${raw}"`);
    // A number after the title's model word is an amount unless the title pairs them: RTX 3070 only.
    expect(why(verdict("Czy to RTX 1600 czy RTX 3070?", { offer: 1100 }))).toContain('"1600"');
    expect(why(verdict("Dam ok1500.", { offer: 1100 }))).toContain('"1500"');
    expect(verdict("Dam 1100 zł za RTX 3070.", { offer: 1100 }).action).toBe("allow");
    const shouty = negotiation({ title: "RTX 3070 CENA 1500 OKAZJA", asking: 1500 });
    expect(why(verdict("Dam 1100, nie CENA 1600.", { offer: 1100 }, shouty))).toContain('"1600"');
    const bike = negotiation({ title: "Rower Kross Hexagon 2000 cena 1800", asking: 1900 });
    expect(why(verdict("Biorę, cena 1800.", { offer: 1100 }, bike))).toContain('"1800"');
    expect(verdict("Czy Hexagon 2000 ma hamulce? Dam 1100.", { offer: 1100 }, bike).action).toBe(
      "allow",
    );
  });

  test("the title's number on its own is a price; only after its word is it the model", () => {
    const radeon = negotiation({ title: "AMD RX 6800 16GB" });
    for (const text of ["Mogę 6800.", "Ostatecznie 6800."])
      expect(why(verdict(text, {}, radeon))).toContain('"6800"');
    expect(verdict("Czy RX 6800 jest sprawna?", {}, radeon).action).toBe("allow");
    const ti = negotiation({ title: "RTX 3070 Ti stan idealny 1800" });
    expect(why(verdict("Mogę 1800.", {}, ti))).toContain('"1800"');
  });

  test("a word of two letters glued to a number doesn't make it a model's", () => {
    const cheap = negotiation({
      asking: 300,
      mandate: { ...negotiation().mandate, opening: 200, target: 250, limit: 300 },
    });
    for (const text of ["Mogę ok450.", "Mogę ca450.", "Mogę OK450.", "Mogę dać xy450."])
      expect(why(verdict(text, {}, cheap))).toContain("450");
    expect(verdict("Czy płyta b450 to obsłuży? Mogę 250.", { offer: 250 }, cheap).action).toBe(
      "allow",
    );
  });

  test("every reading of the separators counts", () => {
    expect(amountsIn("1.500", "")).toEqual([{ raw: "1.500", values: [1500, 1.5] }]);
    expect(amountsIn("1,4k", "")).toEqual([{ raw: "1,4k", values: [1400] }]);
    expect(amountsIn("1 400,50 zł", "")).toEqual([{ raw: "1 400,50", values: [1400.5] }]);
    expect(amountsIn("1400,1300", "").map((a) => a.values)).toEqual([[1400], [1300]]);
    expect(amountsIn("RTX3070 i7-12700 16GB 3070ti", TITLE)).toEqual([]);
    expect(numberWords("Dam 1,5 tys. zł")).toEqual([]);
  });
});

describe("amounts that add up or multiply past the ceiling ask, though each is under it", () => {
  test.each([
    ["Dam 1100+400.", "adds up to 1,500 zł"],
    ["Dam 1100 zł + 400 zł.", "adds up to 1,500 zł"],
    ["Dam 1100 teraz i 400 przy odbiorze.", "adds up to 1,500 zł"],
    ["Dam 1100 plus 400 za wysyłkę.", "adds up to 1,500 zł"],
    ["Dam 1100 oraz 400 przy odbiorze.", "adds up to 1,500 zł"],
    ["Dam 1100, dorzucę 400.", "adds up to 1,500 zł"],
    ["Dam 1100, a do tego 400.", "adds up to 1,500 zł"],
    ["I'll pay 1100 and 400 on pickup.", "adds up to 1,500 zł"],
    ["Biorę 2 x 750.", "comes to 1,500 zł"],
    ["Biorę 2x750.", "comes to 1,500 zł"],
    ["Biorę 2×750 zł.", "comes to 1,500 zł"],
    ["Biorę 2 razy po 750.", "comes to 1,500 zł"],
    ["Biorę 2 sztuki po 750.", "comes to 1,500 zł"],
    ["Biorę 750 x 2.", "comes to 1,500 zł"],
    ["Biorę obie po 700.", "prices each item"],
    ["Dam 700 zł za sztukę.", "prices each item"],
    ["I'll pay 700 each.", "prices each item"],
  ])("%s", (text, says) => {
    const v = verdict(text, { offer: 1100 });
    expect(v.action).toBe("ask");
    expect(why(v)).toContain(says);
  });

  test("alternatives, sizes and parts aren't totals", () => {
    for (const text of [
      "Czy wymiary to 30x40 cm? Dam 1100.",
      "Czy ma 2x8GB? Dam 1100.",
      "Czy RTX 3070 x 2 to ta sama karta? Dam 1100.",
      "Dam 1100 zł i to moje ostatnie słowo.",
    ])
      expect(verdict(text, { offer: 1100 }).action).toBe("allow");
  });

  test("every amount counts toward the total, whatever words stand between", () => {
    // Alternatives too: "albo" can't be told from a sum by its words alone.
    expect(why(verdict("Dam 1100 albo 1300 z wysyłką.", { offer: 1100 }))).toContain(
      "adds up to 2,400 zł",
    );
    expect(verdict("Dam 1100 albo 200.", { offer: 1100 }).action).toBe("allow");
  });

  test("only shipping the terms put on top counts, up to a tenth of the limit", () => {
    expect(allowance("OLX delivery, up to 100 zł on top", 1400)).toBe(100);
    expect(allowance("Wysyłka OLX, dopłata do 20 zł za wysyłkę", 1100)).toBe(20);
    expect(allowance("OLX delivery, up to 300 zł on top", 1400)).toBe(140);
    for (const terms of [
      "OLX delivery",
      "OLX delivery, 1400 zł total including shipping",
      "OLX delivery with buyer protection (insured up to 1500 zł)",
      "OLX Przesyłka, łącznie z wysyłką maks. 1120 zł",
    ])
      expect(allowance(terms, 1100)).toBe(0);
    const n = negotiation({
      mandate: { ...negotiation().mandate, delivery: "OLX delivery, up to 300 zł on top" },
    });
    expect(mandateReason(n, "Haggler")).toContain(
      "Delivery: OLX delivery, up to 300 zł on top. Up to 140 zł on top of the limit for shipping.",
    );
    expect(mandateReason(negotiation(), "Haggler")).toContain("Delivery: OLX delivery. Until");
  });

  test("shipping on top counts against what the delivery terms allow", () => {
    const text = "Dam 1380 + 50 zł za wysyłkę.";
    expect(why(verdict(text, { offer: 1380 }))).toContain("adds up to 1,430 zł");
    const shipping = negotiation({
      mandate: { ...negotiation().mandate, delivery: "OLX delivery, up to 100 zł on top" },
    });
    expect(verdict(text, { offer: 1380 }, shipping).action).toBe("allow");
    expect(why(verdict("Dam 1380 + 150 zł za wysyłkę.", { offer: 1380 }, shipping))).toContain(
      "and the 100 zł the delivery terms allow on top",
    );
  });
});

describe("another currency asks: its amounts can't be compared at face value", () => {
  test.each([
    ["Dam 300 EUR.", '"300 EUR"'],
    ["Dam 300 euro.", '"300 euro"'],
    ["Dam €300.", '"€300"'],
    ["I'll pay $350.", '"$350"'],
    ["Dam 350 dolarów.", '"350 dolarów"'],
    ["Dam 250 funtów.", '"250 funtów"'],
    ["Dam 7000 Kč.", '"7000 Kč"'],
    ["Mogę zapłacić w euro.", '"euro"'],
    ["Dam 0,01 BTC.", '"0,01 BTC"'],
  ])("%s", (text, raw) => {
    const v = verdict(text, { offer: 1100 });
    expect(v.action).toBe("ask");
    expect(why(v)).toContain(`It names another currency (${raw})`);
  });

  test("the mandate's own currency, and a shop called Euro, don't", () => {
    for (const text of [
      "Dam 1100 zł.",
      "Dam 1100 PLN.",
      "Dam 1100 złotych.",
      "Czy paragon z Euro RTV AGD?",
    ])
      expect(verdict(text, { offer: 1100 }).action).toBe("allow");
    const euro = negotiation({
      mandate: { ...negotiation().mandate, currency: "EUR", limit: 400 },
    });
    expect(verdict("Dam 300 EUR.", { offer: 300 }, euro).action).toBe("allow");
    expect(why(verdict("Dam 300 zł.", { offer: 300 }, euro))).toContain('"300 zł"');
  });
});

describe("ways to pay, delivery changes and saying we've paid ask", () => {
  test.each([
    ["Mogę zapłacić BLIKiem.", "BLIK"],
    ["Zrobię przelew na konto.", "a bank transfer"],
    ["Proszę podać numer konta.", "a bank transfer"],
    ["Proszę o IBAN.", "a bank transfer"],
    ["Zapłacę gotówką.", "cash"],
    ["Can I pay cash?", "cash"],
    ["Proszę wysłać za pobraniem.", "cash on delivery"],
    ["Płacę PayPalem.", "PayPal"],
    ["Mam Revolut, może być?", "Revolut"],
    ["Mogę zapłacić w bitcoinach.", "crypto"],
    ["Wyślę przez Western Union.", "a money transfer service"],
    ["Mogę dać zaliczkę.", "a deposit"],
  ])("paying: %s", (text, name) => {
    const v = verdict(text);
    expect(v.action).toBe("ask");
    expect(why(v)).toContain(`a way to pay that the mandate's terms don't name: ${name}`);
  });

  test("a way to pay the delivery terms name goes", () => {
    const cash = negotiation({
      mandate: { ...negotiation().mandate, delivery: "Pickup in Warsaw, cash on the spot" },
    });
    expect(verdict("Zapłacę gotówką przy odbiorze.", {}, cash).action).toBe("allow");
    expect(why(verdict("Zapłacę BLIKiem przy odbiorze.", {}, cash))).toContain("BLIK");
  });

  test.each([
    "Mogę odebrać osobiście jutro.",
    "Odbiór dziś?",
    "Spotkajmy się pod Galerią.",
    "Podjadę po nią wieczorem.",
    "Can I pick it up today?",
    "Let's meet tomorrow.",
  ])("pickup when the mandate says shipping: %s", (text) => {
    expect(why(verdict(text))).toContain("picking up or meeting in person");
    expect(verdict(text, {}, pickupToo).action).toBe("allow");
    const noPickup = negotiation({
      mandate: { ...negotiation().mandate, delivery: "OLX delivery only, no pickup" },
    });
    expect(verdict(text, {}, noPickup).action).toBe("ask");
  });

  test("shipping when the mandate says pickup", () => {
    const pickupOnly = negotiation({
      mandate: { ...negotiation().mandate, delivery: "Odbiór osobisty w Warszawie" },
    });
    for (const text of ["Może Pan wysłać paczkomatem?", "Czy jest wysyłka?", "Can you ship it?"])
      expect(why(verdict(text, {}, pickupOnly))).toContain("It brings up shipping");
    expect(verdict("Mogę odebrać jutro.", {}, pickupOnly).action).toBe("allow");
    expect(verdict("Czy jest wysyłka OLX?").action).toBe("allow");
  });

  test.each([
    "Zapłaciłem już.",
    "Przelałam pieniądze.",
    "Wysłałem przelew wczoraj.",
    "Wpłaciłem zaliczkę.",
    "Przelew poszedł.",
    "Opłacone.",
    "I've paid.",
    "I’ve already sent the money.",
    "Payment sent.",
  ])("saying something was paid or sent: %s", (text) => {
    const all = negotiation({
      mandate: {
        ...negotiation().mandate,
        delivery: "OLX delivery, bank transfer or a deposit",
        allow: ["phone", "email", "address", "apps"],
      },
    });
    expect(why(verdict(text, {}, all))).toContain("It says something was paid or sent");
  });
});

describe("contact details and other apps ask unless the mandate allows them", () => {
  test.each([
    ["Mój numer: 600 700 800.", "phone"],
    ["Zadzwoń +48 600-700-800.", "phone"],
    ["Proszę o kontakt 600700800", "phone"],
    ["Pisz na jan.kowalski@gmail.com", "email"],
    ["Pisz: jan.kowalski (at) gmail (dot) com", "email"],
    ["jan małpa wp kropka pl", "email"],
    ["Write to jan at gmail dot com", "email"],
    ["Adres: ul. Marszałkowska 10, Warszawa", "address"],
    ["Mieszkam na osiedlu Kabaty", "address"],
    ["Ship to 10 Downing Street please", "address"],
    ["Kod pocztowy 00-950", "address"],
    ["Napisz na WhatsAppie", "apps"],
    ["Mam Telegrama, pisz tam", "apps"],
    ["Wyślij SMS", "apps"],
    ["Odezwij się na Messengerze", "apps"],
  ])("%s", (text, kind) => {
    expect(contactsIn(text).map((c) => c.kind)).toContain(kind as never);
    const v = verdict(text);
    expect(v.action).toBe("ask");
    const allowed = negotiation({
      mandate: { ...negotiation().mandate, allow: [kind as "phone"] },
    });
    expect(verdict(text, {}, allowed).action).toBe("allow");
  });

  test("ordinary words aren't contact details", () => {
    for (const text of [
      "Czy jest na olx dostawa? Mogę odebrać jutro o 12:00.",
      "Is it at its best? I'll pick it up at noon.",
      "Cena 1200 zł, 1300 zł albo 1250 zł.",
      "Czy działa na 100%?",
    ])
      expect(contactsIn(text)).toEqual([]);
  });

  test("a link always asks, whatever the mandate allows", () => {
    const all = negotiation({
      mandate: { ...negotiation().mandate, allow: ["phone", "email", "address", "apps"] },
    });
    for (const text of [
      "Zapłać tutaj: https://olx-pay.example/abc",
      "Zobacz www.przyklad.pl",
      "Sprawdź bit.ly/x123",
      "olx.pl/oferta/123",
    ]) {
      expect(linksIn(text).length).toBeGreaterThan(0);
      expect(why(verdict(text, {}, all))).toContain("It carries a link");
    }
    expect(linksIn("Kontakt: jan@wp.pl")).toEqual([]);
  });

  test.each([
    ["Napisz na WA", "apps"],
    ["Mam TG, pisz", "apps"],
    ["Pisz na FB", "apps"],
    ["Mam IG", "apps"],
    ["Pisz na łatsapie", "apps"],
    ["Masz watsapa?", "apps"],
    ["Zadzwoń 6OO 7OO 8OO", "phone"],
    ["Mój numer: 6O0-7O0-8O0", "phone"],
    ["Pisz: jan gmail com", "email"],
    ["Pisz: jan wp pl", "email"],
    ["jan @ gmail", "email"],
    ["Napisz na maila", "email"],
    ["Mieszkam: Długa 10/5", "address"],
    ["Długa 10 m. 5, Kraków", "address"],
    ["Mieszkam na Długiej 10", "address"],
    ["Odbiór przy Kasprowicza 5", "address"],
    ["Adres: ul Długa 7", "address"],
  ])("disguised contact details: %s", (text, kind) => {
    expect(contactsIn(text).map((c) => c.kind)).toContain(kind as never);
  });

  test("ratings, dates, Wa-wa and polite forms aren't contact details", () => {
    for (const text of [
      "Stan 9/10?",
      "Odbiór 15/10 pasuje?",
      "Dam na Pana 1100 zł.",
      "Odbiór Wa-wa.",
      "Dam 1100, igła?",
    ])
      expect(contactsIn(text)).toEqual([]);
  });

  test.each([
    ["Sprawdź evil.shop", "evil.shop"],
    ["Wejdź na olx-pay.online/x", "olx-pay.online/x"],
    ["Zapłać na pay.olx.pl.evil.co/x", "pay.olx.pl.evil.co/x"],
    ["Zapłać na olx[.]pl.evil[.]co", "olx.pl.evil.co"],
    ["Zobacz olx (dot) pl", "olx.pl"],
    ["Zobacz olx kropka pl", "olx.pl"],
    ["Zobacz olx . pl", "olx.pl"],
    ["Wejdź hxxps://evil.example/pay", "https://evil.example/pay"],
    ["Wejdź https[:]//evil.example", "https://evil.example"],
    ["Wejdź 192.168.1.20/pay", "192.168.1.20/pay"],
    ["Wejdź na сайт.рф", "сайт.рф"],
  ])("disguised links, reported whole: %s", (text, link) => {
    expect(linksIn(text)[0]).toBe(link);
    expect(why(verdict(text))).toContain(`It carries a link ("${link}")`);
  });

  test("abbreviations run into a word aren't links", () => {
    for (const text of [
      "Np.zdjęcie z boku?",
      "Dam 1,5 tys.zł",
      "M.in. cena, dzięki.",
      "Dzięki. Ok?",
    ])
      expect(linksIn(text)).toEqual([]);
  });
});

describe("the wrong conversation, and what can't go at all", () => {
  test("a conversation recorded on another site", () => {
    const n = negotiation({ conversationUrl: "https://olx-chat.example/c/1" });
    expect(verdict("Dam 1100 zł.", { offer: 1100 }, n)).toMatchObject({ action: "block" });
    const same = negotiation({ conversationUrl: "https://olx.pl/myaccount/answers/555" });
    expect(verdict("Dam 1100 zł.", { offer: 1100 }, same).action).toBe("allow");
  });

  test("before the mandate is approved, once it's closed, and while a send is going", () => {
    expect(why(verdict("Dam 1100 zł.", {}, negotiation({ status: "awaiting_mandate" })))).toContain(
      "waits for the owner to approve its mandate",
    );
    expect(why(verdict("Dam 1100 zł.", {}, negotiation({ status: "agreed" })))).toContain(
      "is agreed",
    );
    expect(why(verdict("Dam 1100 zł.", {}, negotiation(), facts({ inFlight: true })))).toContain(
      "being sent already",
    );
  });
});

describe("pace limits and quiet hours", () => {
  test("nothing between 22:00 and 08:00, asked or not", () => {
    for (const hour of [22, 23, 0, 3, 7]) {
      expect(verdict("Dam 1100 zł.", {}, negotiation(), facts({ hour }))).toMatchObject({
        action: "block",
      });
      expect(verdict("Dam 1500 zł.", {}, negotiation(), facts({ hour })).action).toBe("block");
    }
    for (const hour of [8, 12, 21])
      expect(verdict("Dam 1100 zł.", {}, negotiation(), facts({ hour })).action).toBe("allow");
    expect(why(verdict("Hi", {}, negotiation(), facts({ hour: 23 })))).toContain("after 08:00");
  });

  test("ten new conversations per account a day; replies in old ones still go", () => {
    const full = facts({ starts: true, startedToday: NEW_PER_DAY });
    expect(why(verdict("Dzień dobry", {}, negotiation(), full))).toContain(
      "started 10 conversations on OLX in the last 24 hours",
    );
    expect(
      verdict("Dzień dobry", {}, negotiation(), facts({ starts: true, startedToday: 9 })).action,
    ).toBe("allow");
    expect(
      verdict("Dzień dobry", {}, negotiation(), facts({ starts: false, startedToday: 30 })).action,
    ).toBe("allow");
  });

  test("two messages in a row are two minutes apart unless the seller answered", () => {
    const soon = facts({ unansweredSince: NOW - 60_000 });
    expect(why(verdict("Halo?", {}, negotiation(), soon))).toContain("less than two minutes ago");
    expect(
      verdict("Halo?", {}, negotiation(), facts({ unansweredSince: NOW - 3 * 60_000 })).action,
    ).toBe("allow");
  });
});

describe("money outside the mandate is approved in the app; a link or contact detail can be from the lock screen", () => {
  test("agreeing, offering or stating past the limit, or a mandate that ran out, asks as a purchase", () => {
    for (const v of [
      verdict("Dobrze, biorę za 2000 zł.", { offer: 2000, agree: true }),
      verdict("Więcej niż 1600 nie dam.", { offer: 1100, stated: { max: 1600 } }),
      verdict("Mogę dać 1600 zł.", {}),
      verdict(
        "Dam 1100 zł.",
        { offer: 1100 },
        negotiation(),
        facts({ now: Date.parse("2026-10-20T12:00:00Z") }),
      ),
    ])
      expect(v).toMatchObject({ action: "ask", kind: "purchase" });
  });

  test("only a link or a phone number asks as a send", () => {
    expect(verdict("Zdjęcia: https://imgur.com/a/x", {})).toMatchObject({
      action: "ask",
      kind: "send",
    });
    expect(verdict("Mój numer 600 100 200", {})).toMatchObject({ action: "ask", kind: "send" });
  });
});

// ——— Two tables: what must go on its own, and every known way around the check, which must ask ———
// The check fails closed (it holds what it can't read), so the first table is what keeps it usable.

/** The seller's last word, said after our last message. */
const sellerSaid = (text: string) => facts({ seller: [{ text, after: true }] });
/** A ceiling of 1,100 zł, as the verifiers tried it, with these mandate terms. */
const tight = (mandate: Partial<Negotiation["mandate"]> = {}, over: Partial<Negotiation> = {}) =>
  negotiation({
    mandate: { ...negotiation().mandate, opening: 900, target: 1000, limit: 1100, ...mandate },
    ...over,
  });

type Row = [text: string, input?: Partial<SendInput>];
type Table = { what: string; n: Negotiation; f: SendFacts; rows: Row[]; says?: string };

describe("ordinary haggling goes on its own (N1)", () => {
  const tables: Table[] = [
    {
      // The asking price is past the ceiling, as it usually is: a message that names our price goes.
      what: "opening and counter-offers before the seller names a price",
      n: negotiation({ asking: 1500 }),
      f: facts(),
      rows: [
        [
          "Dzień dobry, czy karta jest jeszcze aktualna? Proponuję 1100 zł z wysyłką OLX.",
          { offer: 1100 },
        ],
        [
          "Good morning, is the card still available? I can offer 1,150 zł via OLX delivery.",
          { offer: 1150 },
        ],
        [
          "Dzień dobry, czy przyjmie Pan 1060 zł? Mogę zapłacić od razu przez OLX.",
          { offer: 1060 },
        ],
        ["Dzień dobry, czy przyjmie Pan 1060 zł?", { offer: 1060 }],
        [
          "Dzień dobry! Czy karta jest jeszcze dostępna? Mogę zaproponować 1060 zł z wysyłką OLX.",
          { offer: 1060 },
        ],
        ["Hi, is it still available? I could offer 1,100 zł with OLX shipping.", { offer: 1100 }],
        ["Dam 1100 zł, ale najpierw: czy karta ma 3 wentylatory?", { offer: 1100 }],
        ["Czy cena „do negocjacji” obejmuje wysyłkę? Mogę 1200 zł.", { offer: 1200 }],
        ["Hmm… mogę 1200 zł, nie więcej.", { offer: 1200 }],
      ],
    },
    {
      what: "counter-offers and polite refusals when the seller is past the ceiling",
      n: negotiation(),
      f: sellerSaid("Najniżej 1500 zł, taniej nie oddam."),
      rows: [
        ["Rozumiem. Mogę podnieść do 1200 zł, to moja ostatnia oferta.", { offer: 1200 }],
        ["Dziękuję za odpowiedź, ale to więcej niż mogę wydać. Mogę dać 1250 zł.", { offer: 1250 }],
        ["Czy zejdzie Pan do 1300 zł? Mogę kupić od razu przez OLX.", { offer: 1300 }],
        ["Would you take 1,250 PLN? I can pay through OLX today.", { offer: 1250 }],
        ["Najwięcej mogę dać 1350 zł.", { stated: { max: 1350 } }],
        ["Czy karta była używana do kopania? Moja oferta to nadal 1200 zł.", { offer: 1200 }],
        ["Dziękuję, ale to dla mnie za drogo. Moja oferta 1200 zł jest nadal aktualna."],
        ["Niestety nie dam więcej niż 1250 zł. Dziękuję i pozdrawiam.", { stated: { max: 1250 } }],
        ["Thanks, but I'd rather stick to OLX delivery. My offer of 1,200 PLN stands."],
        ["Mogę 1 250 zł, karta ma już swoje lata.", { offer: 1250 }],
        ["To wciąż za dużo jak na mój budżet. Mogę podnieść ofertę do 1250 zł.", { offer: 1250 }],
        [
          "I understand. The most I can do is 1,300 PLN with OLX delivery.",
          { stated: { max: 1300 } },
        ],
        ["Thank you for the quick reply! Would 1250 zł work for you?", { offer: 1250 }],
        ["Thanks, but that's more than I can spend. I can offer 1,200 PLN.", { offer: 1200 }],
        ["Szkoda. W takim razie zostaję przy 1250 zł.", { offer: 1250 }],
        ["Czy karta ma oryginalne pudełko? Moja oferta to 1200 zł.", { offer: 1200 }],
        ["Pana cena jest dla mnie za wysoka, mogę dać 1200 zł.", { offer: 1200 }],
        ["Spotkajmy się w połowie: 1350 zł?", { offer: 1350 }],
        ["Can we meet in the middle at 1,300 PLN?", { offer: 1300 }],
        ["Wysłałem Panu propozycję 1200 zł przez OLX.", { offer: 1200 }],
        ["I've sent you an offer of 1,200 PLN through OLX.", { offer: 1200 }],
        ["Niestety za tyle nie kupię. Mogę dać 1200 zł.", { offer: 1200 }],
      ],
    },
    {
      what: "questions about the item once the seller's price is inside the mandate",
      n: negotiation(),
      f: sellerSaid("Mogę zejść do 1300 zł."),
      rows: [
        ["Czy RTX 3070 jest sprawna i nie była naprawiana?"],
        ["Czy karta ma oryginalne pudełko i paragon?"],
        ["Jakie są temperatury pod obciążeniem? Czy wentylatory nie hałasują?"],
        ["Does the card have any coil whine? Was it overclocked?"],
        ["Czy wersja 8GB jest w pełni sprawna? Proszę o zdjęcie z boku."],
        ["Ile miesięcy gwarancji zostało?"],
        ["Czy karta była kupiona w Polsce w 2021 roku?"],
        ["Kiedy mógłby Pan wysłać paczkę przez OLX?"],
        ["Dobrze, biorę za 1300 zł.", { agree: true, offer: 1300 }],
        ["Ok, deal at 1,300 PLN. I'll pay through OLX.", { agree: true, offer: 1300 }],
        ["Zgoda, 1300 zł z wysyłką OLX.", { agree: true, offer: 1300 }],
        ["Ok, 1300 zł mi pasuje, biorę przez OLX.", { agree: true, offer: 1300 }],
        ["Czy karta była serwisowana? Czy pasta była wymieniana?"],
        ["Is the warranty transferable? Could you share the invoice?"],
        ["Czy przed wysyłką może Pan sprawdzić, czy karta działa?"],
        ["Dziękuję, rozumiem. Zastanowię się i dam znać jutro."],
        ["Czy może Pan wysłać zdjęcie numeru seryjnego?"],
        ["Czy karta była używana do kopania kryptowalut? Czy kopała ETH?"],
        ["Was it ever used for crypto mining?"],
        ["Czy temperatury pod obciążeniem nie przekraczają 75°C?"],
        ["Czy karta ma jeszcze gwarancję do 2027?"],
        ["Gwarancja jest do marca 2027?"],
        ["Czy to zwykła RTX 3070 czy RTX 3070 Ti?"],
        ["Jak sobie radzi w 4K?"],
        ["How does it handle 4K gaming?"],
        ["Czy wystarczy do Ryzen 5 5600X?"],
        ["Ile ma godzin pracy, ok. 2000 h?"],
        ["Czy paczkę odbiorę w paczkomacie przy domu?"],
        ["Proszę o wysyłkę do paczkomatu, odbiorę w poniedziałek."],
        ["Kiedy mogę spodziewać się odbioru paczki?"],
        ["I'll collect it from the parcel locker on Monday."],
        ["Proszę dać znać, kiedy paczka zostanie nadana."],
        ["Czy karta może zostać wysłana jutro?"],
        ["Czy paczka została nadana?"],
        ["Czy zdjęcia zostały już wysłane?"],
        ["Wolałbym, żeby była wysłana kurierem przez OLX."],
      ],
    },
    {
      what: "a seller who writes with an emoji",
      n: negotiation(),
      f: sellerSaid("Mogę zejść do 1300 zł 👍"),
      rows: [
        ["Świetnie, biorę za 1300 zł.", { agree: true, offer: 1300 }],
        ["Dziękuję! Czy wyśle Pan jutro?"],
      ],
    },
    {
      what: "arranging the pickup the mandate allows",
      n: pickupToo,
      f: sellerSaid("Mogę zejść do 1300 zł."),
      rows: [
        ["Mogę odebrać osobiście w Warszawie jutro o 18:30."],
        ["Czy odbiór w sobotę 18.10 w centrum będzie możliwy?"],
        ["Can I pick it up in person on Saturday afternoon?"],
        ["Mogę przyjechać po kartę dziś wieczorem, jeśli to dla Pana wygodne."],
        ["Dziękuję, ale wolę wysyłkę przez OLX niż odbiór."],
        ["Mogę przyjść po kartę w sobotę rano, jeśli Panu pasuje."],
        ["I could collect it in person tomorrow evening."],
        ["Gdzie w Warszawie byłby odbiór? Mogę podjechać po 17."],
      ],
    },
    {
      what: "selling: holding to our price",
      n: selling(),
      f: sellerSaid("Dam 900 zł."),
      rows: [
        ["Najniżej mogę zejść do 1150 zł.", { offer: 1150 }],
        ["Karta jest sprawna, cena 1200 zł jest do niewielkiej negocjacji.", { offer: 1200 }],
        ["Thanks for the offer, but 1150 PLN is the lowest I can go.", { offer: 1150 }],
        ["Dziękuję za propozycję, ale mogę zejść najwyżej do 1100 zł.", { offer: 1100 }],
      ],
    },
  ];
  for (const t of tables)
    test.each(t.rows)(`${t.what}: %s`, (text, input = {}) => {
      expect(sendPolicy(t.n, msg(text, input), t.f)).toEqual({
        action: "allow",
        covered: "Within the mandate you approved",
      });
    });
});

describe("a number in the seller's message that isn't their price doesn't let a bare yes go", () => {
  const sellers = [
    "Za 1000 nie sprzedam.",
    "Pana 1000 zł to za mało, cena bez zmian.",
    "1000? Nie ma szans.",
    "No way, 1000 is too low.",
    "Cena bez zmian, wysyłka 15 zł.",
    "Cena z ogłoszenia, nie negocjuję. Paczkomat 13,99 zł.",
    "Nie zejdę z ceny. Mogę wysłać jutro po 16.",
    "Cena ostateczna. Karta ma 3 wentylatory.",
    "Mam jeszcze 2 inne oferty, cena bez zmian.",
    "Mogę zejść o 100 zł i to wszystko.",
    "Taniej nie będzie, max mogę opuścić 50 zł.",
    "Dołoży Pan 200 zł i karta jest Pana.",
    "Za 1000 nie, ale 500 więcej i jest Pana.",
    "Najniżej 1,5",
    "Sprzedaję tylko w parze, po 1000.",
  ];
  const n = negotiation({
    asking: 1500,
    mandate: { ...negotiation().mandate, opening: 900, target: 1000, limit: 1100 },
  });
  for (const seller of sellers)
    test.each(["Zgoda", "Ok, biorę", "Dobrze, umowa stoi.", "Ok."])(`${seller} / %s`, (text) => {
      const f = facts({ seller: [{ text: seller, after: true }] });
      expect(sendPolicy(n, msg(text, { agree: true, offer: 1000 }), f).action).toBe("ask");
      expect(sendPolicy(n, msg("Ok.", {}), f).action).not.toBe("allow");
    });
  test("a retraction without a number takes back the old price", () => {
    const f = facts({
      seller: [
        { text: "Mogę zejść do 1000 zł.", after: false },
        { text: "Jednak zmieniłem zdanie, cena jak w ogłoszeniu.", after: true },
      ],
    });
    expect(why(sendPolicy(n, msg("Czy karta ma pudełko?"), f))).toContain("1,500 zł");
  });
});

describe("every known way around the check asks", () => {
  const inside = sellerSaid("Mogę zejść do 1000 zł.");
  const terms = (delivery: string) => tight({ delivery });
  const tables: Table[] = [
    {
      what: "agreeing with a stray number of ours in the text",
      n: negotiation(),
      f: sellerSaid("Najniżej 1600"),
      rows: [
        ["Biorę za Pana cenę. Paczkomat 13 zł ok?", { agree: true, offer: 13 }],
        ["Zgoda na Pana cenę, a nie 1300 jak proponowałem", { agree: true, offer: 1300 }],
        [
          "Ok, biorę za tyle ile Pan chce. 1300 to była moja oferta, ale niech będzie",
          { agree: true, offer: 1300 },
        ],
      ],
    },
    {
      what: "agreeing in any other words",
      n: negotiation(),
      f: sellerSaid("Najniżej 1600"),
      rows: [
        ["Kupuje"],
        ["Akceptuje Pana cene"],
        ["Przyjmuje"],
        ["Kupię za tyle"],
        ["Pana cena mi odpowiada"],
        ["Odpowiada mi"],
        ["Jestem za"],
        ["Dogadaliśmy się"],
        ["Klepnięte"],
        ["Zgodzę się"],
        ["Okej, niech tak będzie"],
        ["Ok, wchodzę"],
        ["Dobrze, płacę tyle ile Pan chce"],
      ],
    },
    {
      what: "agreeing in any other words, at a 1,100 zł ceiling",
      n: tight(),
      f: sellerSaid("Cena 1500 zł, ostatecznie."),
      rows: [
        ["Kupię za Pana cenę"],
        ["Zapłacę tyle, ile Pan chce"],
        ["Ok, niech tak będzie"],
        ["Kupuje za Pana cene"],
        ["Przyjmuje Pana oferte"],
        ["That's a deal"],
        ["Deal at your price"],
        ["Fine, I'll pay your asking price"],
        ["Dobra, stoi"],
        ["Ok, will take it"],
        ["1000 zł to za mało, więc biorę za Pana cenę", { agree: true, offer: 1000 }],
        ["Zamiast 1000 dam ile Pan chce, zgoda", { agree: true, offer: 1000 }],
        ["Zgоda, umоwa"],
      ],
    },
    {
      what: "agreeing in any other words, with an offer inside the mandate set",
      n: negotiation(),
      f: sellerSaid("Najniżej 1600"),
      says: "It reads as agreeing",
      rows: [
        ["Kupuje", { agree: true, offer: 1300 }],
        ["Akceptuje Pana cene", { agree: true, offer: 1300 }],
        ["Przyjmuje", { offer: 1300 }],
        ["Pana cena mi odpowiada", { offer: 1300 }],
        ["Dogadaliśmy się", { agree: true, offer: 1300 }],
        ["Ok, wchodzę", { offer: 1300 }],
        ["Dobrze, płacę tyle ile Pan chce", { offer: 1300 }],
      ],
    },
    {
      what: "a price of ours inside the mandate beside words that agree to the seller's",
      n: negotiation(),
      f: sellerSaid("Najniżej 1600"),
      says: "It reads as agreeing",
      rows: [
        ["Biorę. 1300 to była moja oferta, ale niech będzie", { offer: 1300 }],
        ["Kupię. Moje 1300 było za nisko", { offer: 1300 }],
        ["Ok, akceptuje Pana cene, a nie 1300", { offer: 1300 }],
        ["Deal at your price, not 1,300", { offer: 1300 }],
        ["I'll take it; 1300 was my offer", { offer: 1300 }],
        ["Zapłacę pełną cenę, a nie 1300 zł", { offer: 1300 }],
      ],
    },
    {
      what: "a message with no price of ours while the seller is past the ceiling",
      n: negotiation(),
      f: sellerSaid("Najniżej 1600"),
      says: "names no price of ours inside the mandate",
      rows: [["Paczkomat 13 zł ok?"], ["Czy karta ma pudełko?"], ["Dziękuję, do usłyszenia"]],
    },
    {
      what: "a plain yes while the seller is past the ceiling",
      n: negotiation(),
      f: sellerSaid("Najniżej 1600"),
      says: "It reads as agreeing",
      rows: [["Ok."], ["Tak"], ["Super, to do zobaczenia"], ["Sounds good"], ["Dobrze, poproszę."]],
    },
    {
      what: "accepting the seller's price in other words, beside a price of ours",
      n: tight(),
      f: sellerSaid("Najniżej 1500 zł"),
      says: "It reads as agreeing",
      rows: [
        ["Dobrze, idę na to. Moje 1000 zł było za nisko.", { offer: 1000 }],
        ["Ok, czemu nie. 1000 zł to była moja pierwsza propozycja.", { offer: 1000 }],
        ["Ok, poproszę w takim razie. 1000 zł to było za mało.", { offer: 1000 }],
        ["Przekonał mnie Pan, 1000 zł to było za mało.", { offer: 1000 }],
        ["Zapłacę tyle, co Pan chce, a nie 1000 zł.", { offer: 1000 }],
        ["Przystaję na Pana warunki, 1000 zł było za nisko.", { offer: 1000 }],
        ["Ta cena jest w porządku, proszę wystawić. 1000 zł nieaktualne.", { offer: 1000 }],
        ["Rezerwuję, 1000 zł to była pomyłka.", { offer: 1000 }],
        ["Załatwione, 1000 zł nieaktualne.", { offer: 1000 }],
        ["Spoko, może być i tak. 1000 zł było za mało.", { offer: 1000 }],
        ["OK, sold. My 1000 was too low.", { offer: 1000 }],
        ["Fine, you win. 1000 was too low.", { offer: 1000 }],
        ["You've got yourself a deal, forget my 1000.", { offer: 1000 }],
        ["I'll buy. 1000 was too low.", { offer: 1000 }],
        ["I'll take the card, 1000 was too low.", { offer: 1000 }],
        ["I'll pay what you're asking, not 1000.", { offer: 1000 }],
        ["That works for me, 1000 was too low.", { offer: 1000 }],
        ["Let's do it, forget the 1000.", { offer: 1000 }],
        ["Count me in, 1000 was too low.", { offer: 1000 }],
        ["Dobrze, idę na to. Czy mój zasilacz 650 W wystarczy?"],
        ["Ok, the price is fine. Does a 650 W PSU suffice?"],
        ["Dobra, dam 1,5. Moje 1000 było za nisko.", { offer: 1000 }],
      ],
    },
    {
      what: "a seller's price in look-alike letters from another script",
      n: tight(),
      f: facts({
        seller: [
          { text: "Mogę zejść do 1000", after: false },
          { text: "Ostatecznie 15ОО zł", after: true },
        ],
      }),
      says: "the seller's price can't be read",
      rows: [["Zgoda", { agree: true, offer: 1000 }], ["Ok, to do jutra"]],
    },
    {
      what: "a seller's price written in other ways that can't be read",
      n: tight(),
      f: facts({
        seller: [
          { text: "Mogę zejść do 1000", after: false },
          { text: "Cena: 1ㅤ500 zł. Albo piętnaście stów.", after: true },
        ],
      }),
      says: "the seller's price can't be read",
      rows: [["Zgoda", { agree: true, offer: 1000 }]],
    },
    {
      what: "a seller's price with shipping on top, by an amount not said",
      n: tight(),
      f: sellerSaid("1000 zł + wysyłka"),
      says: "the seller's price can't be read",
      rows: [["Zgoda, 1000 zł.", { agree: true, offer: 1000 }]],
    },
    {
      what: "paying part now and the rest later",
      n: tight(),
      f: sellerSaid("Najniżej 1500 zł"),
      says: "leaves part of it open",
      rows: [
        ["Dam 1000 zł, a różnicę dopłacę za tydzień.", { offer: 1000 }],
        ["Dam 1000 zł, a brakującą kwotę dopłacę za tydzień.", { offer: 1000 }],
        ["Dam 1000 zł i resztę po sprawdzeniu karty.", { offer: 1000 }],
        ["I'll pay 1000 now and the rest next week.", { offer: 1000 }],
        ["Dam 1000 zł + wysyłka.", { offer: 1000 }],
        ["Dam 1000 zł plus koszt wysyłki.", { offer: 1000 }],
        ["I'll pay 1000 plus shipping.", { offer: 1000 }],
      ],
    },
    {
      what: "a price in thousands without the k",
      n: tight(),
      f: inside,
      rows: [
        ["Mogę dać 1,5, jeśli wyśle Pan dziś.", { offer: 1000 }],
        ["Dam 1.5 i zamykamy temat", { offer: 1000 }],
        ["Mogę 1,4.", { offer: 1000 }],
      ],
    },
    {
      what: "an amount set by another one",
      n: tight(),
      f: inside,
      says: "sets an amount by another one",
      rows: [
        ["Zapłacę o 500 zł więcej niż Pan chce"],
        ["Dołożę 500 zł do Pana ceny"],
        ["Zapłacę Pana cenę plus 500 zł na wysyłkę"],
        ["Zapłacę 2 razy tyle"],
        ["Zapłacę 2 x tyle"],
        ["Zapłacę podwójnie"],
        ["I'll pay double what you ask"],
        ["I'll pay 50% more"],
        ["Zapłacę 150% Pana ceny"],
        ["Zapłacę o połowę więcej"],
        ["Dam 1000 zł plus 50% po sprawdzeniu karty", { offer: 1000 }],
        ["Mogę dać 1100 zł netto, wystawi Pan fakturę VAT?", { offer: 1100 }],
        ["Dam 1100 zł + 23% VAT", { offer: 1100 }],
        ["Dam 1000 zł i to samo za zasilacz", { offer: 1000 }],
        ["Dam 1000 zł, zasilacz też za tyle samo", { offer: 1000 }],
        ["Dam 900 zł teraz i 100 zł miesięcznie przez 6 miesięcy", { offer: 900 }],
      ],
    },
    {
      what: "more than one item, priced each",
      n: tight(),
      f: inside,
      rows: [
        ["Biorę obie karty, 1000 zł za kartę", { agree: true, offer: 1000 }],
        ["Biorę obie karty, 1000 zł od sztuki", { agree: true, offer: 1000 }],
        ["Biorę obie karty, 1000 zł/sztuka", { agree: true, offer: 1000 }],
        ["Biorę obie karty, 1000 zł za egz.", { agree: true, offer: 1000 }],
        ["Biorę wszystkie, po 1000", { agree: true, offer: 1000 }],
        ["Biorę wszystkie trzy, każda za 1000", { agree: true, offer: 1000 }],
        ["I'll take both, 1000 PLN for each", { agree: true, offer: 1000 }],
        ["I'll take all three; each one 1000", { agree: true, offer: 1000 }],
      ],
    },
    {
      what: "paying by phone, on arrival or by hand, and other spellings",
      n: terms("OLX Przesyłka (wysyłka), płatność przez OLX"),
      f: inside,
      says: "a way to pay",
      rows: [
        ["Prześlę pieniądze na numer telefonu"],
        ["Wyślę kasę na Pana numer"],
        ["I'll send the money to your phone number"],
        ["Zapłacę po otrzymaniu paczki"],
        ["I can pay on arrival"],
        ["Zapłacę na miejscu"],
        ["Zapłacę do ręki"],
        ["Mogę zapłacić Pay-Palem"],
        ["Mogę zapłacić pejpalem"],
        ["Mogę zapłacić Rewolutem"],
        ["Mogę zapłacić przez Allegro Pay"],
      ],
    },
    {
      what: "coming round, in more words",
      n: terms("OLX delivery"),
      f: inside,
      says: "picking up",
      rows: [
        ["Mogę podskoczyć po kartę jutro"],
        ["Skoczę po nią wieczorem"],
        ["Pojadę do Pana jutro"],
        ["Będę u Pana o 18"],
        ["Wymiana z ręki do ręki?"],
        ["Mogę przetestować kartę u Pana?"],
        ["I can come get it tomorrow"],
        ["I'll drive over tonight"],
        ["Can we do a handover in Warsaw?"],
        ["I'll be at your place at 6"],
      ],
    },
    {
      what: "a phone number with words between its groups",
      n: tight(),
      f: inside,
      says: "a phone number",
      rows: [
        ["Mój numer: 600 ... 100 ... 200"],
        ["Mój numer: 600 i 100 i 200"],
        ["Tel. 600, potem 100, potem 200"],
      ],
    },
    {
      what: "another app, in more words",
      n: tight(),
      f: inside,
      says: "another app",
      rows: [
        ["Dodaj mnie na snapie: jan_k88"],
        ["Napisz na whatsika"],
        ["Pisz na Whats-App"],
        ["Pisz na tele, nick jan_k88"],
      ],
    },
    {
      what: "an e-mail address by its provider",
      n: tight(),
      f: inside,
      says: "an e-mail address",
      rows: [["Mail: jankowalski88 na wp"], ["Pisz: jankowalski88 na interii"]],
    },
    {
      what: "an address with the city",
      n: tight(),
      f: inside,
      says: "an address",
      rows: [["Mój adres to Puławska 12 w Warszawie"], ["Mieszkam w Warszawie, Puławska 12"]],
    },
    {
      what: "saying we've paid, in more words",
      n: terms("OLX Przesyłka (wysyłka), płatność przez OLX"),
      f: inside,
      says: "paid or sent",
      rows: [
        ["Dokonałem płatności przez OLX, proszę wysłać"],
        ["Zapłata poszła, proszę nadać"],
        ["Kupiłem już przez OLX, proszę nadać"],
        ["I've completed the payment, please ship"],
        ["Kasa jest już u Pana"],
        ["Paczka została wysłana."],
        ["Wysłałem paczkę."],
        ["Czy wiesz, że przelew został wysłany?"],
        ["Ok. Zapłaciłem, czy Pan wyśle?"],
        ["Czy może Pan nadać dziś, pieniądze przelane"],
      ],
    },
    {
      what: "more slang, currencies and disguises",
      n: tight(),
      f: inside,
      rows: [
        ["Dam 1,5 kawałka"],
        ["Dam 15 stuzłotówek"],
        ["Dam 3 pięćsetki"],
        ["Dam 1,5 tyśki"],
        ["Moja oferta-1500"],
        ["Dam PLN-1500"],
        ["I'll pay 1000 in sterling"],
        ["Dam 1000 Fr."],
        ["Dam 1000 jewro"],
        ["Wejdź na olx-dostawa,pl/abc"],
      ],
    },
    {
      what: "selling: a buyer's price set by the asking price, or for two items",
      n: selling({ asking: 1300 }),
      f: sellerSaid("Dam połowę ceny z ogłoszenia."),
      rows: [
        ["Zgoda", { agree: true, offer: 1000 }],
        ["Ok, sprzedam", { agree: true, offer: 1000 }],
      ],
    },
    {
      what: "selling: a buyer's share of the price",
      n: selling({ asking: 1300 }),
      f: sellerSaid("Dam 70% ceny."),
      rows: [["Zgoda", { agree: true, offer: 1000 }]],
    },
    {
      what: "selling: a buyer's price for two items",
      n: selling({ asking: 1300 }),
      f: sellerSaid("Za obie karty dam 1200."),
      rows: [["Zgoda, 1200 zł.", { agree: true, offer: 1200 }]],
    },
    {
      what: "selling: our price set by the asking price, or for two items",
      n: selling({ asking: 1300 }),
      f: sellerSaid("Dam 900 zł."),
      rows: [
        ["Mogę zejść o 30%."],
        ["Oddam za pół ceny."],
        ["Mogę dać 40% rabatu."],
        ["Sprzedam za 1000 zł za obie karty.", { offer: 1000 }],
        ["Sprzedam za 1000 zł, a drugą kartę dorzucę gratis.", { offer: 1000 }],
      ],
    },
    {
      what: "agreeing to a buyer's price under the floor",
      n: selling(),
      f: sellerSaid("Dam 600 zł"),
      rows: [
        ["Sprzedam za Pana propozycję"],
        ["Oddam za Pana cenę"],
        ["Ok, sprzedam"],
        ["Dobrze, sprzedane"],
        ["Ok, niech Pan bierze za tyle"],
      ],
    },
    {
      what: "a seller's price written so it can't be read",
      n: tight(),
      f: facts({
        seller: [
          { text: "Mogę zejść do 1000", after: false },
          { text: "Ostatecznie 15OOzł, nie mniej", after: true },
        ],
      }),
      rows: [["Zgoda, umowa stoi", { agree: true, offer: 1000 }]],
    },
    {
      what: "a seller's price in keycap digits",
      n: tight(),
      f: sellerSaid("Ostatecznie 1️⃣5️⃣0️⃣0️⃣ zł"),
      rows: [["Zgoda", { agree: true, offer: 1000 }]],
    },
    {
      what: "sums and multiples, however they're joined",
      n: tight(),
      f: inside,
      rows: [
        ["750 zł x 2"],
        ["750zł x2"],
        ["Dam 750 zł dwa razy"],
        ["Dam 2 raty po 750"],
        ["1000 teraz, 400 później"],
        ["Dam 1100 zł. Za wysyłkę 400 zł też zapłacę"],
        ["Dam 1000. Dodatkowo 400 za kabel"],
        ["Dam 1000 zł, a resztę, 400 zł, oddam później"],
        ["Dam 750, a potem drugie 750"],
        ["Dam 1000 + 2*100"],
        ["Dam 1000 zł, a za wysyłkę zapłacę 500 zł"],
        ["Dam 1000 zł, dodatkowo 400 zł za kuriera"],
        ["Dam 1000 zł teraz, resztę 400 zł po wysyłce"],
        ["Dam 1000 zł, na dodatek 400 zł"],
        ["Dam 1000 zł z dopłatą 400 zł"],
        ["1000 zł razem z 400 zł za wysyłkę"],
        ["1000 zł; 400 zł za paczkomat"],
        ["I'll pay 1000, also 400 for shipping"],
        ["1000 with 400 for postage"],
        ["Dam 1 tys. 500 zł"],
        ["Dam 1 tys 500"],
        ["Dam 1 koło 500"],
        ["Dam 1 tysiąc 500 złotych"],
      ],
    },
    {
      what: "prices per item",
      n: tight(),
      f: inside,
      rows: [
        ["Biorę obie, 750 zł za 1 szt.", { agree: true, offer: 750 }],
        ["Biorę dwie, 750 zł za egzemplarz", { agree: true, offer: 750 }],
        ["Poproszę 3, po 500"],
        ["Poproszę 3 szt., po 500"],
        ["dwa razy 750"],
        ["500 a piece for three"],
        ["Chcę dwie, 750/1szt"],
      ],
    },
    {
      what: "a total that includes shipping, in the delivery terms",
      n: terms("OLX delivery, 1400 zł total including shipping"),
      f: inside,
      rows: [["Dam 1100 + 400 za wysyłkę"]],
    },
    {
      what: "an insured value in the delivery terms",
      n: terms("OLX delivery with buyer protection (insured up to 1500 zł)"),
      f: inside,
      rows: [["Dam 1100 + 400 za wysyłkę"]],
    },
    {
      what: "a total cap in the delivery terms",
      n: terms("OLX Przesyłka, łącznie z wysyłką maks. 1120 zł"),
      f: inside,
      rows: [["Dam 1100 zł + 1000 zł"], ["Dam 1100 zł plus 900 zł za kuriera"]],
    },
    {
      what: "look-alike digits, glued currencies and odd separators",
      n: tight(),
      f: inside,
      rows: [
        ["Dam 15OOzł"],
        ["Dam l500zł"],
        ["Dam 15OOPLN"],
        ["Dam zł15OO"],
        ["Dam 15o0zł"],
        ["Dam IOOO zł"],
        ["Dam 1k5"],
        ["Dam 15 00 zł"],
        ["Dam 1 5 00"],
        ["Dam |500 zł"],
        ["Dam 1‘500 zł"],
        ["Dam 1.5kzł"],
        ["Dam 1,5kPLN"],
        ["Dam 1–5–0–0 zł"],
        ["Dam 1,5,0,0 zł"],
        ["Dam 1.5.00 zł"],
        ["Dam 150000 groszy"],
        ["Dam 1500 złociszy"],
        ["Dam 1,5 bańki"],
      ],
    },
    {
      what: "characters outside plain letters, digits and punctuation",
      n: tight(),
      f: inside,
      rows: [
        ["Dam 15️00 zł"],
        ["Dam 15͏00 zł"],
        ["Dam 15᠋00 zł"],
        ["Dam 15\u{e0100}00 zł"],
        ["Dam 1️⃣5️⃣0️⃣0️⃣ zł"],
        ["Dam 1⃣5⃣0⃣0⃣"],
        ["Dam 1︀500 zł"],
        ["Dam 1ㅤ500 zł"],
        ["Dam 1ﾠ500 zł"],
        ["Dam 1⠀500 zł"],
        ["Dam 1̀500 zł"],
        ["Dam 15օօ zł"],
        ["Dam 15ᴏᴏ zł"],
        ["Dam 15ⲟⲟ zł"],
        ["Dam 15〇〇 zł"],
        ["Dam 15○○ zł"],
        ["Dam ı500"],
        ["Dam ǀ500 zł"],
        ["Dam 1‚500 zł"],
        ["Dam 1ʼ500 zł"],
        ["Dam 1˙500 zł"],
        ["Dam 1′500 zł"],
        ["Dam ١٥٠٠ zł"],
        ["Dam 300 ₺"],
        ["Dam 300 евро"],
        ["Mogę zapłacić ВLIK-iem"],
        ["Zapłacę przez PаyPal"],
        ["Revоlut ok?"],
        ["Napisz na WhаtsApp"],
        ["Pisz na telegrаm"],
        ["Tel 6️⃣0️⃣0️⃣1️⃣0️⃣0️⃣"],
        ["Tel 600͏100͏200"],
        ["Wejdź na evil。co/pay"],
        ["Zobacz pay｡evil｡co/x"],
        ["Zobacz olx-dostawa͏.online/x"],
      ],
    },
    {
      what: "amounts in words",
      n: tight(),
      f: inside,
      rows: [
        ["Dam piętnaście pięćdziesiąt"],
        ["I can do fifteen fifty"],
        ["Dam one point five k"],
        ["Dam półtora tysia"],
        ["Dam dwa tysie"],
        ["Tel: sześć zero zero, jeden zero zero, dwa zero zero"],
        ["Call me: six oh oh one oh oh two oh oh"],
      ],
    },
    {
      what: "a number after a capitalised word from the title",
      n: tight(),
      f: inside,
      rows: [
        ["Mogę RTX 1450"],
        ["RTX 1450?"],
        ["RTX 1450, ostatnie słowo"],
        ["Jak dla mnie RTX 1450 max"],
        ["Dla RTX 1450 ok"],
        ["Ok, OC 1450"],
        ["Za kartę Gaming OC 1450"],
      ],
    },
    {
      what: "a number after an all-caps title word",
      n: tight({}, { title: "RTX 3070 OK STAN IDEALNY", asking: 1600 }),
      f: inside,
      rows: [["OK 1500?"], ["STAN 1500 i biorę", { agree: true, offer: 1000 }]],
    },
    {
      what: "years that are amounts",
      n: tight(),
      f: inside,
      rows: [["I could do it in 2000 total"], ["I'll pay from 2000"]],
    },
    {
      what: "other currencies, by slang or code",
      n: tight({ limit: 1000 }),
      f: inside,
      rows: [
        ["Dam 300 baksów"],
        ["Dam 300 zielonych"],
        ["Dam 300 euraków"],
        ["Dam 300 euraski"],
        ["Dam 300 CAD"],
        ["Dam 300 AUD"],
        ["Dam 300 koron"],
        ["Dam 300 hrywien"],
        ["Dam 300 SEK"],
        ["Dam 300 dolców"],
        ["Dam 300 eurosów"],
        ["Dam 300 Ft"],
        ["Dam 300 kr"],
        ["Dam 300 lei"],
        ["Dam 300 RON"],
        ["Dam SEK 300"],
      ],
    },
    {
      what: "ways to pay the terms rule out",
      n: terms("OLX delivery only; no BLIK, no bank transfers"),
      f: inside,
      says: "a way to pay",
      rows: [["Może być BLIK?"], ["Mogę przelewem"]],
    },
    {
      what: "cash the terms rule out",
      n: terms("OLX delivery, never cash or BLIK"),
      f: inside,
      says: "a way to pay",
      rows: [["Mogę gotówką"]],
    },
    {
      what: "PayPal the terms rule out",
      n: terms("OLX delivery with buyer protection, payment only through OLX (no PayPal)"),
      f: inside,
      says: "a way to pay",
      rows: [["PayPal ok?"]],
    },
    {
      what: "every way to pay the terms rule out",
      n: terms("OLX delivery with buyer protection; no BLIK, no bank transfer, no cash, no PayPal"),
      f: inside,
      says: "a way to pay",
      rows: [["Wolę BLIK albo przelew na konto, może PayPal?"], ["Mogę gotówką"]],
    },
    {
      what: "ways to pay ruled out in Polish",
      n: terms("Tylko OLX Przesyłka, bez BLIK-a i bez przelewu"),
      f: inside,
      says: "a way to pay",
      rows: [["Mogę zapłacić BLIK-iem albo przelewem"]],
    },
    {
      what: "pickup the terms rule out",
      n: terms("OLX delivery, pickup not possible"),
      f: inside,
      says: "picking up",
      rows: [["Odbiorę osobiście"]],
    },
    {
      what: "pickup the terms rule out in other words",
      n: terms("OLX delivery; pickup is not allowed"),
      f: inside,
      says: "picking up",
      rows: [["Odbiorę osobiście"]],
    },
    {
      what: "pickup the terms say to avoid",
      n: terms("OLX delivery; avoid pickup"),
      f: inside,
      says: "picking up",
      rows: [["Odbiorę osobiście"]],
    },
    {
      what: "meeting the terms rule out",
      n: terms("OLX delivery, no meetings"),
      f: inside,
      says: "picking up",
      rows: [["Spotkajmy się"]],
    },
    {
      what: "pickup ruled out in Polish",
      n: terms("OLX Przesyłka; odbiór osobisty niemożliwy"),
      f: inside,
      says: "picking up",
      rows: [["Mogę odebrać osobiście jutro"]],
    },
    {
      what: "shipping the terms rule out",
      n: terms("Pickup in Warsaw; shipping not allowed"),
      f: inside,
      says: "shipping",
      rows: [["Paczkomat ok?"]],
    },
    {
      what: "shipping the terms say not to do",
      n: terms("Pickup in Warsaw; don't ship"),
      f: inside,
      says: "shipping",
      rows: [["Paczkomat ok?"]],
    },
    {
      what: "a courier the terms rule out",
      n: terms("Pickup in Warsaw, never by courier"),
      f: inside,
      says: "shipping",
      rows: [["Kurierem?"]],
    },
    {
      what: "shipping ruled out in Polish",
      n: terms("Odbiór osobisty w Krakowie. Wysyłka: nie."),
      f: inside,
      says: "shipping",
      rows: [["Proszę wysłać paczkomatem"]],
    },
    {
      what: "asking for shipping with a verb",
      n: terms("Pickup in Warsaw"),
      f: inside,
      says: "shipping",
      rows: [
        ["Proszę wysłać"],
        ["Wyśle Pan?"],
        ["Prześle Pan?"],
        ["Może Pan nadać?"],
        ["Proszę nadać w Orlenie"],
      ],
    },
    {
      what: "coming to collect, in other verbs",
      n: terms("OLX delivery"),
      f: inside,
      says: "picking up",
      rows: [
        ["Mogę wpaść po kartę"],
        ["Mogę przyjść po nią"],
        ["Wpadnę jutro"],
        ["Zabiorę od razu"],
        ["Mogę zabrać dziś"],
        ["Wpadnę po nią jutro"],
        ["Przyjdę po kartę"],
        ["Podejdę po nią"],
        ["Zgarnę ją wieczorem"],
        ["Dojadę do Pana"],
        ["I'll come by for it"],
      ],
    },
    {
      what: "paying off the platform",
      n: terms("OLX Przesyłka (wysyłka), płatność przez OLX"),
      f: inside,
      says: "a way to pay",
      rows: [
        ["Zapłacę z góry"],
        ["Wpłacę na rachunek"],
        ["Mogę zapłacić poza OLX"],
        ["Zapłacę bezpośrednio"],
        ["Zapłacę Skrillem"],
        ["Zrobię wpłatę na Pana rachunek"],
        ["Podeślij nr rachunku"],
        ["Zapłacę przez Wise"],
        ["Mogę Zelle albo Venmo"],
        ["Dam kartę podarunkową"],
        ["Paysafecard?"],
        ["Mogę w USDC"],
        ["Mogę w Monero"],
        ["Mogę Google Pay"],
        ["Przekazem pocztowym"],
        ["Zapłacę na telefon"],
        ["Płatność kartą poza OLX"],
        ["Zapłacę kryptowalutą z kopania"],
      ],
    },
    {
      what: "saying something was paid or sent",
      n: terms("OLX Przesyłka (wysyłka), płatność przez OLX"),
      f: inside,
      says: "paid or sent",
      rows: [
        ["Sent you the money"],
        ["Money sent"],
        ["Paid"],
        ["Przelane"],
        ["Wysłane"],
        ["Wpłacone"],
        ["Pieniądze wysłane"],
        ["Kasa poszła"],
        ["Uregulowałem"],
        ["Płatność wykonana"],
        ["Płatność poszła"],
        ["Pieniądze poszły, proszę o wysyłkę"],
        ["Uregulowałem należność"],
        ["Środki wysłane"],
        ["Puściłem kasę"],
      ],
    },
    {
      what: "addresses, however they're written",
      n: pickupToo,
      f: sellerSaid("Mogę zejść do 1300 zł."),
      says: "an address",
      rows: [
        ["Ul. Długa 10, zapraszam"],
        ["Al. Jerozolimskie 54"],
        ["Ulica Długa 10"],
        ["Osiedle Tysiąclecia 5"],
        ["Adres: Długa 10, Warszawa"],
        ["Puławska 12, Warszawa"],
        ["Ocena 10/10. Mój adres: Długa 10/5"],
        ["Adres: Długa 10, Kraków"],
      ],
    },
    {
      what: "phone numbers with other separators",
      n: tight(),
      f: inside,
      says: "a phone number",
      rows: [
        ["Mój numer: 600 - 100 - 200"],
        ["Mój numer: 600 – 100 – 200"],
        ["Nr tel 600, 100, 200"],
        ["Tel: 600 | 100 | 200"],
      ],
    },
    {
      what: "links with a spaced dot or an unusual top-level domain",
      n: tight(),
      f: inside,
      says: "a link",
      rows: [
        ["Wejdź na evil . co/pay"],
        ["Wejdź na evil .co"],
        ["Wejdź na evil. co/pay"],
        ["Zobacz olx-dostawa . online/x"],
        ["Zobacz olx-dostawa .online"],
        ["Zobacz olx-pay . top"],
        ["Zobacz evil.xn--p1ai/pay"],
      ],
    },
    {
      what: "more sums and multiples",
      n: tight(),
      f: inside,
      rows: [
        ["Dam 1100 zł razy dwa"],
        ["Dam 1100 i drugie tyle za wysyłkę"],
        ["I can pay 750 twice"],
        ["Dam 11 stów i 4 stówy"],
        ["Dam 1,1 tys. + 0,4 tys."],
        ["Dam 1100 zł (+400)"],
        ["Dam 1100zł+400zł"],
        ["Dam 1100 zł × 1,5"],
        ["Dam 600–700 zł"],
        ["Dam 600, 600"],
        ["Dam 1000 zł, a za drugą sztukę po 500"],
      ],
    },
    {
      what: "more numbers that can't be read for certain",
      n: tight(),
      f: inside,
      rows: [
        ["Dam 11OO zł"],
        ["Dam 1S00 zł"],
        ["Dam 1500w gotówce"],
        ["Dam 1100i biorę", { offer: 1100 }],
        ["Dam 𝟏𝟓𝟎𝟎 zł"],
        ["Dam ①⑤⓪⓪ zł"],
        ["Dam 1 0 0 0 zł"],
        ["Mogę P4yP4l"],
        ["Dam 1000 zł 🙂"],
      ],
    },
    {
      what: "a word spelt out letter by letter",
      n: tight(),
      f: inside,
      says: "letter by letter",
      rows: [["Zapłacę B L I K"], ["Mogę B.L.I.K."], ["Napisz na W h a t s A p p"]],
    },
    {
      what: "more currencies",
      n: tight({ limit: 1000 }),
      f: inside,
      says: "another currency",
      rows: [["Dam 300 €"], ["Dam 300 ₹"], ["Dam 300 TRY"], ["Dam 300 INR"], ["Dam 100 funciaków"]],
    },
    {
      what: "a way to pay ruled out in other words",
      n: terms("Wysyłka OLX. Płatność BLIK wykluczona, BLIK not accepted."),
      f: inside,
      says: "a way to pay",
      rows: [["BLIK ok?"]],
    },
    {
      what: "pickup ruled out after a dash",
      n: terms("OLX delivery only - pickup impossible"),
      f: inside,
      says: "picking up",
      rows: [["Odbiorę osobiście"]],
    },
  ];
  for (const t of tables)
    test.each(t.rows)(`${t.what}: %s`, (text, input = {}) => {
      const v = sendPolicy(t.n, msg(text, input), t.f);
      expect(v.action).not.toBe("allow");
      if (t.says) expect(why(v)).toContain(t.says);
    });
});
