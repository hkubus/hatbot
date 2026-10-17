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
    ["Mogę dać 1 250 zł, odbiór dziś.", 1250],
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
      expect(verdict(text)).toMatchObject({ action: "allow" });
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

  test("every reading of the separators counts", () => {
    expect(amountsIn("1.500", "")).toEqual([{ raw: "1.500", values: [1500, 1.5] }]);
    expect(amountsIn("1,4k", "")).toEqual([{ raw: "1,4k", values: [1400] }]);
    expect(amountsIn("1 400,50 zł", "")).toEqual([{ raw: "1 400,50", values: [1400.5] }]);
    expect(amountsIn("1400,1300", "").map((a) => a.values)).toEqual([[1400], [1300]]);
    expect(amountsIn("RTX3070 i7-12700 16GB 3070ti", TITLE)).toEqual([]);
    expect(numberWords("Dam 1,5 tys. zł")).toEqual([]);
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
    ["Odbiór: ul. Marszałkowska 10, Warszawa", "address"],
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
