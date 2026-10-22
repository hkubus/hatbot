// The desktop's click and Enter checks and its approvals' kinds, without a desktop.
import { expect, test } from "bun:test";
import type { AgentElement } from "@hatbot/shared/desktop";
import { marketplaceSend } from "../src/negotiate/marketplace";
import { approvalKind, notCovered } from "../src/tasks/approval-kind";
import { checkFor, checkoutHost, consequential, samePage } from "../src/tasks/policy";

const button = (label: string, over: Partial<AgentElement> = {}): AgentElement => ({
  tag: "button",
  role: null,
  type: "button",
  label,
  inForm: false,
  ...over,
});

test("buy, pay, order, offer, send and delete labels are held; everyday ones, look-alikes and cards linking elsewhere aren't", () => {
  const held = [
    "Kup teraz",
    "Zamawiam i płacę",
    "Zaproponuj cenę",
    "Wyślij wiadomość",
    "Usuń ogłoszenie",
    "Akceptuj ofertę",
    "Koupit nyní",
    "Odeslat zprávu",
    "Place order",
    "Delete account",
    "Przejdź do kasy",
    // Folded: a zero-width space, a soft hyphen, fullwidth letters, and Unicode word edges.
    "Ku​p teraz",
    "Zap­łać",
    "Ｐａｙ ｎｏｗ",
    "Wypłać",
    "Przejdź do płatności",
    "Odpowiedz",
  ];
  for (const label of held)
    expect([label, consequential("click", button(label))]).toEqual([label, { label }]);
  const fine = [
    "Dodaj do koszyka",
    "Moje zamówienia",
    "Napisz wiadomość",
    "Accept all",
    "PayPal",
    "Payments history",
    "Bezpłatnie",
    "Usuńmy",
    "Dalej",
    // Tabs, headings and an address that read like buying, and a cookie banner's choices.
    "Kupujący",
    "Zakupione",
    "Wystawione",
    "Odpowiedź",
    "Historia płatności",
    "Plac Wolności 1, Kraków",
    "E-book: Rust in Action",
    "Potwierdź moje wybory",
    "Confirm my choices",
  ];
  for (const label of fine)
    expect([label, consequential("click", button(label))]).toEqual([label, null]);

  // A card linking to another page opens it, whatever its words; a link that stays may run anything.
  const tile =
    "Sony WH-1000XM5 Słuchawki bezprzewodowe nauszne z redukcją szumów 1299 zł Kup teraz";
  const link = { tag: "a", url: "https://allegro.pl/listing" };
  expect(
    consequential("click", button(tile, { ...link, href: "https://allegro.pl/oferta/1" })),
  ).toBeNull();
  expect(
    consequential("click", button(tile, { ...link, href: "https://allegro.pl/listing#" })),
  ).toEqual({ label: tile });
});

test("an icon-only button or clickable div is held unless it toggles; a search form's submit searches unless it pays", () => {
  expect(consequential("click", button(""))).toEqual({ unlabelled: "button" });
  expect(consequential("click", button("", { tag: "div", role: "clickable", type: null }))).toEqual(
    { unlabelled: "button" },
  );
  expect(consequential("click", button("", { toggle: true }))).toBeNull();
  expect(consequential("click", button("", { tag: "a" }))).toBeNull();
  expect(consequential("click", button("Apply filters"))).toBeNull();
  expect(consequential("click", button("Apply"))).toEqual({ label: "Apply" });
  const searchSubmit = { type: "submit", inForm: true, search: true };
  expect(consequential("click", button("Potwierdź", searchSubmit))).toBeNull();
  expect(consequential("click", button("Zapłać", searchSubmit))).toEqual({ label: "Zapłać" });
  expect(consequential("click", button("", { type: "submit", inForm: true }))).toEqual({
    label: "Submit",
  });
});

test("on a checkout page or in a payment frame every button asks; typing and choosing don't", () => {
  const checkout = "https://allegro.pl/zamowienie/podsumowanie";
  expect(consequential("click", button("Dalej", { url: checkout }))).toEqual({
    checkout: "allegro.pl",
  });
  const radio = button("Paczkomat", { role: "radio", toggle: true, url: checkout });
  expect(consequential("click", radio)).toBeNull();
  const street = button("Ulica", { tag: "input", type: "text", editable: true, url: checkout });
  expect(consequential("click", street)).toBeNull();
  // The tab's address is an ordinary page; the payment gateway's frame says more.
  const confirm = button("Confirm", {
    url: "https://fundacja.example/wesprzyj",
    frameUrl: "https://js.stripe.com/v3/elements-inner",
  });
  expect(consequential("click", confirm)).toEqual({ checkout: "js.stripe.com" });
  // A frame Hatbot couldn't enter can't be told apart from a Pay button.
  const frame = button("Secure payment", { tag: "iframe", type: null });
  expect(consequential("click", frame)).toEqual({ frame: "Secure payment" });

  const pages: [string, string | null][] = [
    ["https://secure.payu.com/pay/?orderId=1", "secure.payu.com"],
    ["https://shop.myshopify.com/12345/checkouts/abc", "shop.myshopify.com"],
    ["https://shop.example/index.php?route=checkout/confirm", "shop.example"],
    ["https://shop.example/index.php?controller=order-history", null],
    ["https://shop.example/account/orders/12", null],
    ["https://www.paypal.com.evil.example/", null],
    ["https://example.com/blog/how-to-pay-less", null],
  ];
  for (const [url, host] of pages) expect([url, checkoutHost(url)]).toEqual([url, host]);
});

test("Enter asks when the button it would press sends or pays, or has no name", () => {
  const box = (over: Partial<AgentElement> = {}): AgentElement => ({
    tag: "textarea",
    role: null,
    type: null,
    label: "Napisz wiadomość",
    inForm: false,
    editable: true,
    ...over,
  });
  const field = box({ tag: "input", type: "text", inForm: true, submitLabel: "Zamawiam i płacę" });
  expect(consequential("enter", field)).toEqual({ label: "Zamawiam i płacę" });
  expect(consequential("newline", field)).toEqual({ label: "Zamawiam i płacę" });
  expect(consequential("enter", { ...field, submitLabel: "Szukaj" })).toBeNull();
  expect(consequential("enter", box({ buttonsAfter: ["", "Wyślij"] }))).toEqual({
    label: "Wyślij",
  });
  expect(consequential("enter", box())).toEqual({ unlabelled: "beside" });
  expect(consequential("enter", box({ buttonsAfter: ["Dodaj zdjęcie", "Emoji"] }))).toBeNull();
  expect(consequential("newline", box({ buttonsAfter: ["Wyślij"] }))).toBeNull();
  expect(consequential("space", button("Kup teraz"))).toEqual({ label: "Kup teraz" });
});

test("keys and typed text that could submit unseen are refused; single presses are checked", () => {
  const focused = [{ focused: true as const }];
  const key = (text: string) => checkFor("computer", "key", { text });
  // The Enter after Tab acts on something the check never saw; a held Enter repeats.
  expect(key("Tab Return")).toHaveProperty("refuse");
  expect(checkFor("computer", "hold_key", { text: "Return", duration: 1 })).toHaveProperty(
    "refuse",
  );
  // Keycodes, keysyms and a modifier after the key are Enter under another name.
  for (const text of ["36", "0xff0d", "U000D", "KP_Space", "Return+shift"])
    expect([text, key(text)]).toEqual([text, { refuse: expect.stringContaining("can't read") }]);
  expect(key("Control_L+Return")).toEqual({ press: "enter", at: focused });
  expect(key("shift+Return")).toEqual({ press: "newline", at: focused });
  expect(key("ctrl+a BackSpace")).toBeNull();

  const type = (text: string, toolset: "computer" | "browser" = "browser") =>
    checkFor(toolset, "type", { text });
  expect(type("Dzień dobry\n")).toEqual({ press: "enter", at: focused });
  expect(type("Jan\tKowalski")).toBeNull();
  expect(type("Jan\tul. Polna 5")).toHaveProperty("refuse");
  expect(type(" JavaScript:void(0)", "computer")).toEqual({
    refuse: expect.stringContaining("javascript:"),
  });
  expect(type("Data: 15 października", "computer")).not.toHaveProperty("refuse");
});

test("a click is checked where it lands, whatever the mouse does; a right click is refused", () => {
  expect(checkFor("computer", "right_click", { coordinate: [3, 4] })).toHaveProperty("refuse");
  expect(checkFor("computer", "left_mouse_up", {})).toEqual({
    press: "click",
    at: [{ cursor: true }],
  });
  expect(
    checkFor("computer", "left_click_drag", { start_coordinate: [10, 20], coordinate: [300, 520] }),
  ).toEqual({
    press: "click",
    at: [
      { x: 10, y: 20 },
      { x: 300, y: 520 },
    ],
  });
  expect(checkFor("browser", "middle_click", { target: { type: "ref", ref: "ref_2" } })).toEqual({
    press: "click",
    at: [{ ref: "ref_2" }],
  });
  expect(checkFor("computer", "scroll", {})).toBeNull();
});

test("the same page is the same address and query, in any order and tracking aside", () => {
  const p = "https://shop.example/item";
  expect(samePage(`${p}?id=1&size=m`, `${p}/?size=m&id=1&utm_source=x&fbclid=y#reviews`)).toBe(
    true,
  );
  expect(samePage(`${p}?id=1`, `${p}?id=2`)).toBe(false);
  expect(samePage(p, "https://other.example/item")).toBe(false);
});

test("outside a negotiation, a click or Enter that could message a seller asks; searching doesn't", () => {
  const url = "https://www.olx.pl/d/oferta/rower-CID1-ID77.html";
  const box = (fields: string[]): AgentElement => ({
    tag: "textarea",
    role: null,
    type: null,
    label: "Wiadomość",
    inForm: true,
    url,
    editable: true,
    fields,
  });
  // The Send button has only an icon, so no label marks it as a send.
  const send = (fields: string[]) => ({
    ...box(fields),
    tag: "button",
    label: "",
    editable: false,
  });
  expect(marketplaceSend("enter", box(["Czy aktualne?"]), null)).toContain(
    "with text in a box on olx.pl",
  );
  expect(marketplaceSend("click", send(["Czy aktualne?"]), null)).toContain("olx.pl");
  expect(marketplaceSend("click", send([]), null)).toBeNull();
  expect(marketplaceSend("click", { ...send(["1000"]), label: "Pokaż wyniki" }, null)).toBeNull();
  expect(
    marketplaceSend("enter", { ...box(["Czy aktualne?"]), url: "https://x.example/" }, null),
  ).toBeNull();
});

test("a checkout page, a payment host or the held step raises the kind, whatever the model called it", () => {
  const blank = { summary: "Continue to the next step" };
  const at = (url: string | null, text = "") => ({ url, text });
  const listing = at("https://www.olx.pl/d/oferta/rower-CID1-ID77.html");
  expect(approvalKind("send", { summary: "Ask the seller" }, listing)).toBe("send");
  expect(approvalKind("other", blank, at("https://sklep.example.pl/zamowienie/podsumowanie"))).toBe(
    "purchase",
  );
  expect(approvalKind("other", blank, at("https://gate.gopay.cz/gw/v3/123"))).toBe("payment");
  expect(approvalKind("send", { summary: "Ask" }, listing, { label: "Kup teraz" })).toBe(
    "purchase",
  );
  expect(approvalKind("other", blank, listing, { frame: "" })).toBe("purchase");
  expect(approvalKind("send", { summary: "Zamów i zapłać" }, at(null))).toBe("purchase");
  // A shop's footer lists BLIK on every page; only a BLIK code field makes it a payment.
  const footer = at("https://shop.example/kontakt", "Płatności: BLIK, Visa, Mastercard");
  expect(approvalKind("send", { summary: "Send the reply to Anna" }, footer)).toBe("send");
  expect(approvalKind("purchase", { summary: "Confirm" }, at(null, "Podaj kod BLIK"))).toBe(
    "payment",
  );
});

test("an approval covers the step it was asked for, on its page; one from the lock screen never buys", () => {
  const page = "https://www.olx.pl/d/oferta/rower-CID1-ID77.html";
  const send = { page, kind: "send" as const, summary: "Send it", hold: { label: "Wyślij" } };
  expect(notCovered(send, { label: "wyślij" }, `${page}#x`)).toBeNull();
  expect(notCovered(send, { label: "Kup teraz" }, page)).toContain('the step on "Wyślij"');
  expect(notCovered(send, { label: "Wyślij" }, "https://www.olx.pl/")).toContain("not this page");
  // Asked before trying: it covers a step whose label it names, never one with no label, and not one
  // that buys unless it was a purchase.
  const ahead = { page, kind: "send" as const, summary: "Click Wyślij to ask", hold: null };
  expect(notCovered(ahead, { label: "WYŚLIJ" }, page)).toBeNull();
  expect(notCovered(ahead, { label: "Usuń ogłoszenie" }, page)).toContain("not this step");
  expect(notCovered(ahead, { unlabelled: "button" }, page)).toContain("not this step");
  expect(notCovered(ahead, { checkout: "www.olx.pl" }, page)).toContain("kind purchase");
  const buy = { ...ahead, kind: "purchase" as const, summary: "Click Kup teraz" };
  expect(notCovered(buy, { label: "Kup teraz" }, page)).toBeNull();
  // The control it named: the page's own label, or the icon it said it would press.
  const named = { ...ahead, summary: "Ask the seller about the frame", control: "Wyślij" };
  expect(notCovered(named, { label: "wyślij" }, page)).toBeNull();
  expect(notCovered(named, { unlabelled: "button" }, page)).toBeNull();
  expect(notCovered(named, { label: "Usuń ogłoszenie" }, page)).toContain("not this step");
  expect(notCovered({ ...named, control: undefined }, { label: "Wyślij" }, page)).toContain(
    "not this step",
  );
});
