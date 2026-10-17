// negotiate_send's policy, case by case (PLAN.md §16.3): what goes on its own, what asks, what can't go.
import { describe, expect, test } from "bun:test";
import type { Negotiation } from "@hatbot/shared";
import {
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
  asking: 1500,
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
      "Czy karta to RTX 3070 czy RTX 3080? Dam 1100 zł.",
      "Ma 8 GB, a zasilacz 650 W wystarczy? 1100 zł.",
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
    expect(v).toMatchObject({ action: "ask", kind: "send", always: true });
    expect(why(v)).toContain("Offering 1,450 zł is above the ceiling of 1,400 zł.");
  });

  test("selling: below the floor; at it or above goes", () => {
    const v = verdict("Mogę zejść do 950 zł.", { offer: 950 }, selling());
    expect(why(v)).toContain("Offering 950 zł is below the floor of 1,000 zł.");
    expect(verdict("Mogę zejść do 1000 zł.", { offer: 1000 }, selling()).action).toBe("allow");
    expect(verdict("Najniżej 1 150 zł.", { offer: 1150 }, selling()).action).toBe("allow");
    // Selling, an amount in the text below the floor asks too.
    expect(why(verdict("Niech będzie 900 zł.", {}, selling()))).toContain('"900"');
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
    expect(verdict("Czy to RTX 1600 czy RTX 3070?", { offer: 1100 }).action).toBe("allow");
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
      "Dam 1100 albo 1300 z wysyłką.",
      "Czy wymiary to 30x40 cm? Dam 1100.",
      "Czy ma 2x8GB? Dam 1100.",
      "Czy RTX 3070 x 2 to ta sama karta? Dam 1100.",
      "Dam 1100 zł i to moje ostatnie słowo.",
    ])
      expect(verdict(text, { offer: 1100 }).action).toBe("allow");
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
