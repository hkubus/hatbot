// The desktop's click and Enter checks (PLAN.md §6.1), without a desktop.
import { expect, test } from "bun:test";
import type { AgentElement } from "@hatbot/shared/desktop";
import {
  checkFor,
  checkoutHost,
  consequential,
  consequentialLabel,
  fold,
  heldBack,
  pressOf,
  samePage,
} from "../src/tasks/policy";

const button = (label: string, over: Partial<AgentElement> = {}): AgentElement => ({
  tag: "button",
  role: null,
  type: "button",
  label,
  inForm: false,
  ...over,
});

test("buy, pay, order, offer, send and delete labels from OLX, Allegro and Vinted are held", () => {
  const held = [
    // Allegro
    "Kup teraz",
    "KUP TERAZ",
    "Zamawiam i płacę",
    "Kupuję i płacę",
    "Licytuj",
    "Przejdź do płatności",
    "Potwierdź zakup",
    "Zamówienie z obowiązkiem zapłaty",
    "Złóż zamówienie",
    // OLX
    "Kup z Przesyłką OLX",
    "Zaproponuj cenę",
    "Wyślij",
    "Wyślij wiadomość",
    "Odpowiedz",
    "Usuń",
    "Usuń ogłoszenie",
    "Opublikuj ogłoszenie",
    "Podbij ogłoszenie",
    // Vinted
    "Zapłać",
    "ZAPŁAĆ",
    "Zaplac",
    "Opłać zamówienie",
    "Potwierdź",
    "Akceptuj ofertę",
    "Zaakceptuj ofertę",
    "Złóż ofertę",
    "Make an offer",
    "Buy now",
    // Czech: Vinted.cz, Bazoš, Sbazar
    "Koupit",
    "Koupit nyní",
    "Zaplatit",
    "Zaplaťte kartou",
    "Přejít k platbě",
    "Objednat",
    "Dokončit objednávku",
    "Objednávka zavazující k platbě",
    "Nabídnout cenu",
    "Přijmout nabídku",
    "Poslat",
    "Odeslat zprávu",
    "Potvrdit",
    "Smazat inzerát",
    "Odstranit",
    "Zarezervovat",
    // English, as before
    "Pay now",
    "Place order",
    "Send",
    "Delete account",
    "Proceed to checkout",
  ];
  for (const label of held) {
    expect([label, consequential("click", button(label))]).toEqual([label, { label }]);
  }
});

test("everyday labels, cookie banners and words that only look alike go through", () => {
  const fine = [
    "Dodaj do koszyka",
    "Do koszyka",
    "Kontynuuj zakupy",
    "Moje zamówienia",
    "Wysłane",
    "Wysyłka",
    "Użyj kuponu",
    "Kupony",
    "Napisz wiadomość",
    "Obserwuj",
    "Pokaż numer",
    "Przejdź do koszyka",
    "Akceptuję",
    "Zaakceptuj wszystkie",
    "Accept all",
    "Přijmout vše",
    "Odeslané",
    "Moje objednávky",
    "PayPal",
    "Facebook",
    "Booking.com",
    "Orders",
    "Následující",
    "Dalej",
    "Next",
  ];
  for (const label of fine)
    expect([label, consequential("click", button(label))]).toEqual([label, null]);
});

test("filter, sort and search buttons are exempt; buying in them isn't", () => {
  for (const label of [
    "Apply filters",
    "Usuń filtry",
    "Remove filter",
    "Potwierdź filtry",
    "Smazat filtry",
    "Sortuj",
    "Seřadit",
    "Pokaż wyniki",
    "Zobrazit výsledky",
    "Szukaj",
  ])
    expect([label, consequential("click", button(label))]).toEqual([label, null]);
  // "Apply" on its own still asks; so does buying from a search page.
  expect(consequential("click", button("Apply"))).toEqual({ label: "Apply" });
  expect(consequential("click", button("Kup teraz - wyniki"))).toEqual({
    label: "Kup teraz - wyniki",
  });
  // A submit button in a search form searches.
  expect(
    consequential("click", button("", { type: "submit", inForm: true, search: true })),
  ).toBeNull();
  expect(
    consequential("click", button("Potwierdź", { type: "submit", inForm: true, search: true })),
  ).toBeNull();
  expect(
    consequential("click", button("Zapłać", { type: "submit", inForm: true, search: true })),
  ).toEqual({ label: "Zapłać" });
  expect(consequential("click", button("", { type: "submit", inForm: true }))).toEqual({
    label: "Submit",
  });
});

test("icon-only buttons are held, unless they open or close something", () => {
  expect(consequential("click", button(""))).toEqual({ unlabelled: "button" });
  expect(consequential("click", button("➤"))).toEqual({ unlabelled: "button" });
  expect(consequential("click", button("", { tag: "div", role: "button" }))).toEqual({
    unlabelled: "button",
  });
  expect(consequential("click", button("", { tag: "input", type: "image" }))).toEqual({
    unlabelled: "button",
  });
  expect(consequential("click", button("", { toggle: true }))).toBeNull();
  // Not a button: a link with only an icon, or plain text.
  expect(consequential("click", button("", { tag: "a" }))).toBeNull();
  expect(consequential("click", button("", { tag: "div" }))).toBeNull();
});

test("Enter in a form asks when its submit button would", () => {
  const field: AgentElement = {
    tag: "input",
    role: null,
    type: "text",
    label: "Imię",
    inForm: true,
    submitLabel: "Zamawiam i płacę",
  };
  expect(consequential("enter", field)).toEqual({ label: "Zamawiam i płacę" });
  expect(consequential("enter", { ...field, submitLabel: "Szukaj" })).toBeNull();
});

test("paying, ordering and accepting a price under other common words are held", () => {
  for (const label of [
    "Płacę",
    "Płacę BLIKiem",
    "Płacę kartą",
    "Przejdź do kasy",
    "Do kasy",
    "Complete payment",
    "Make payment",
    "Payment",
    "Wykonaj przelew",
    "Zleć przelew",
    "Zatwierdź przelew",
    "Przyjmuję ofertę",
    "Akceptuję cenę",
    "Zaakceptuj propozycję",
    "Wysyłam",
    // A zero-width space inside the word.
    "Ku\u200bp teraz",
    "Zap\u00adłać",
  ])
    expect([label, consequentialLabel(label)]).toEqual([label, true]);
  for (const label of ["Kasa fiskalna", "Placement", "Payments history"])
    expect([label, consequentialLabel(label)]).toEqual([label, false]);
});

test("a div or icon the page made clickable is held like a button", () => {
  const div = button("", { tag: "div", role: "clickable", type: null });
  expect(consequential("click", div)).toEqual({ unlabelled: "button" });
  expect(consequential("click", { ...div, label: "Kup teraz" })).toEqual({ label: "Kup teraz" });
  expect(consequential("click", { ...div, label: "Galeria" })).toBeNull();
});

test("labels are compared folded and with Unicode word edges", () => {
  expect(fold("  ZAPŁAĆ\n teraz ")).toBe("zaplac teraz");
  // \b would see a word edge inside "płać" and "Usuń".
  expect(consequentialLabel("Wypłać")).toBe(true);
  expect(consequentialLabel("Usuńmy")).toBe(false);
  expect(consequentialLabel("zapłata")).toBe(true);
  expect(consequentialLabel("Bezpłatnie")).toBe(false);
  // Fullwidth letters only look different.
  expect(fold("Ｐａｙ ｎｏｗ")).toBe("pay now");
  expect(consequentialLabel("Ｐａｙ ｎｏｗ")).toBe(true);
});

test("the same page is the same address and query, in any order and tracking aside", () => {
  const p = "https://shop.example/item";
  expect(samePage(`${p}?id=1&size=m`, `${p}/?size=m&id=1&utm_source=x&fbclid=y`)).toBe(true);
  expect(samePage(`${p}?id=1#reviews`, `${p}?id=1`)).toBe(true);
  expect(samePage(`${p}?id=1`, `${p}?id=2`)).toBe(false);
  expect(samePage(`${p}?id=1`, p)).toBe(false);
  expect(samePage(p, "https://other.example/item")).toBe(false);
});

test("Space with the keyboard off the page is told what Space does there, not Enter", () => {
  expect(heldBack("space", { outside: true })).toContain("where Space may press something");
  expect(heldBack("enter", { outside: true })).toContain("where Enter opens what was typed");
});

test("on a checkout or payment page every button asks; typing and choosing don't", () => {
  const checkout = "https://allegro.pl/zamowienie/podsumowanie";
  expect(consequential("click", button("Dalej", { url: checkout }))).toEqual({
    checkout: "allegro.pl",
  });
  expect(consequential("click", button("", { tag: "a", url: checkout }))).toEqual({
    checkout: "allegro.pl",
  });
  const radio = button("Paczkomat", { role: "radio", toggle: true, url: checkout });
  expect(consequential("click", radio)).toBeNull();
  const street = button("Ulica", { tag: "input", type: "text", editable: true, url: checkout });
  expect(consequential("click", street)).toBeNull();
  // A label still says more than the page.
  expect(consequential("click", button("Zapłać", { url: checkout }))).toEqual({ label: "Zapłać" });
  const field = button("Kod", { tag: "input", type: "text", inForm: true, url: checkout });
  expect(consequential("enter", field)).toEqual({ checkout: "allegro.pl" });

  const pages: [string, string | null][] = [
    ["https://www.vinted.pl/checkout?transaction_id=1", "www.vinted.pl"],
    ["https://secure.payu.com/pay/?orderId=1", "secure.payu.com"],
    ["https://go.przelewy24.pl/trnRequest/1", "go.przelewy24.pl"],
    ["https://www.olx.pl/d/delivery/checkout/abc", "www.olx.pl"],
    ["https://www.alza.cz/pokladna", "www.alza.cz"],
    // Shopify, PrestaShop, IdoSell, Amazon and OpenCart.
    ["https://shop.example/checkouts/cn/Z2Nw", "shop.example"],
    ["https://shop.myshopify.com/12345/checkouts/abc", "shop.myshopify.com"],
    ["https://shop.example/order", "shop.example"],
    ["https://shop.example/order/confirm", "shop.example"],
    ["https://sklep.example.pl/order1.php", "sklep.example.pl"],
    ["https://www.amazon.pl/gp/buy/spc/handlers/display.html", "www.amazon.pl"],
    ["https://shop.example/index.php?route=checkout/confirm", "shop.example"],
    ["https://shop.example/index.php?controller=order", "shop.example"],
    ["https://shop.example/index.php?controller=order-history", null],
    ["https://shop.example/orders", null],
    ["https://shop.example/account/orders/12", null],
    ["https://allegro.pl/oferta/rtx-3070-123", null],
    ["https://allegro.pl/moje-allegro/zakupy/zamowienia", null],
    ["https://www.paypal.com.evil.example/", null],
    ["https://example.com/blog/how-to-pay-less", null],
    ["not a url", null],
  ];
  for (const [url, host] of pages) expect([url, checkoutHost(url)]).toEqual([url, host]);
});

test("Enter, Space and Tab can't slip past: sequences are refused, single presses checked", () => {
  const focused = [{ focused: true as const }];
  const key = (text: string, more: Record<string, unknown> = {}) =>
    checkFor("computer", "key", { text, ...more });
  // The Enter after Tab, or after another Enter, acts on something the check never saw.
  expect(key("Tab Enter")).toHaveProperty("refuse");
  expect(key("Tab Return")).toHaveProperty("refuse");
  expect(key("Return Return")).toHaveProperty("refuse");
  expect(key("Tab space")).toHaveProperty("refuse");
  expect(key("Return", { repeat: 2 })).toHaveProperty("refuse");
  expect(checkFor("computer", "hold_key", { text: "Return", duration: 1 })).toHaveProperty(
    "refuse",
  );
  expect(checkFor("browser", "hold_key", { text: "space", duration: 1 })).toHaveProperty("refuse");
  expect(key("Return")).toEqual({ press: "enter", at: focused });
  expect(key("ctrl+Return")).toEqual({ press: "enter", at: focused });
  expect(key("KP_Enter")).toEqual({ press: "enter", at: focused });
  expect(key("shift+Return")).toEqual({ press: "newline", at: focused });
  expect(key("space")).toEqual({ press: "space", at: focused });
  expect(key("Tab")).toBeNull();
  expect(key("ctrl+a BackSpace")).toBeNull();
  expect(checkFor("computer", "hold_key", { text: "shift", duration: 1 })).toBeNull();

  const type = (text: string) => checkFor("browser", "type", { text });
  expect(type("Dzień dobry\n")).toEqual({ press: "enter", at: focused });
  expect(type("Dzień dobry")).toEqual({ press: "space", at: focused });
  expect(type("Jan\tKowalski")).toBeNull();
  expect(type("Jan\tul. Polna 5")).toHaveProperty("refuse");
  expect(type("Jan\t\n")).toHaveProperty("refuse");
});

test("only an address that runs script is refused as typed text, not a sentence that starts alike", () => {
  const type = (text: string, toolset: "computer" | "browser" = "computer") =>
    checkFor(toolset, "type", { text });
  for (const text of ["javascript:alert(1)", " JavaScript:void(0)", "data:text/html,<b>Hi</b>"])
    expect([text, type(text)]).toEqual([text, { refuse: expect.stringContaining("javascript:") }]);
  for (const text of ["Data: 15 października", "Javascript: tutorial", "data"])
    expect([text, type(text)]).not.toEqual([text, { refuse: expect.anything() }]);
  // The browser toolset types into the page, never the address bar.
  expect(type("javascript:void(0)", "browser")).toBeNull();
});

test("a key Hatbot can't read is refused, so Enter can't go under another name", () => {
  const key = (text: string) => checkFor("computer", "key", { text });
  // Keycodes, hex and Unicode keysyms, keypad and line-feed keys xdotool would press as Return or space,
  // a modifier after the key (xdotool presses it after), and two keys at once.
  for (const text of [
    "36",
    "104",
    "0xff0d",
    "0x20",
    "U0020",
    "U000D",
    "KP_Space",
    "Linefeed",
    "ISO_Enter",
    "3270_Enter",
    "Return+shift",
    "Return+ctrl",
    "KP_Enter+a",
    "space+Tab",
    "ctrl+a 0xff0d",
  ])
    expect([text, key(text)]).toEqual([text, { refuse: expect.stringContaining("can't read") }]);
  expect(checkFor("computer", "hold_key", { text: "36", duration: 1 })).toHaveProperty("refuse");
  expect(checkFor("browser", "key", { text: "U0020" })).toHaveProperty("refuse");
  // Names in any case, X's modifier names, and characters read as they are.
  expect(key("RETURN")).toEqual({ press: "enter", at: [{ focused: true }] });
  expect(key("Control_L+Return")).toEqual({ press: "enter", at: [{ focused: true }] });
  expect(key("Shift_L+Return")).toEqual({ press: "newline", at: [{ focused: true }] });
  expect(key("ctrl+shift+Return")).toEqual({ press: "enter", at: [{ focused: true }] });
  expect(key("Next")).toBeNull();
  expect(key("ctrl++")).toBeNull();
  expect(key("5")).toBeNull();
  expect(key("ą")).toBeNull();
  expect(pressOf("0xff0d")).toBeNull();
});

test("a right click is refused: its menu is a window Hatbot can't see into", () => {
  expect(checkFor("computer", "right_click", { coordinate: [3, 4] })).toHaveProperty("refuse");
  expect(
    checkFor("browser", "right_click", { target: { type: "ref", ref: "ref_2" } }),
  ).toHaveProperty("refuse");
});

test("a middle click is checked where it lands", () => {
  expect(checkFor("computer", "middle_click", { coordinate: [3, 4] })).toEqual({
    press: "click",
    at: [{ x: 3, y: 4 }],
  });
  expect(checkFor("browser", "middle_click", { target: { type: "ref", ref: "ref_2" } })).toEqual({
    press: "click",
    at: [{ ref: "ref_2" }],
  });
});

test("mouse down, up and drags are checked where they land", () => {
  expect(checkFor("computer", "left_mouse_down", {})).toEqual({
    press: "click",
    at: [{ cursor: true }],
  });
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
  const point = (x: number, y: number) => ({ type: "coordinate", x, y });
  expect(checkFor("browser", "left_mouse_up", { target: point(5, 6) })).toEqual({
    press: "click",
    at: [{ x: 5, y: 6 }],
  });
  expect(
    checkFor("browser", "left_click_drag", { from: point(1, 2), target: point(300, 520) }),
  ).toEqual({
    press: "click",
    at: [
      { x: 1, y: 2 },
      { x: 300, y: 520 },
    ],
  });
  expect(checkFor("browser", "left_click", { target: { type: "ref", ref: "ref_7" } })).toEqual({
    press: "click",
    at: [{ ref: "ref_7" }],
  });
  expect(checkFor("computer", "left_click", { coordinate: [3, 4] })).toEqual({
    press: "click",
    at: [{ x: 3, y: 4 }],
  });
  expect(checkFor("computer", "scroll", {})).toBeNull();
});

test("Enter in a chat box asks when the button after it sends, or has no name", () => {
  const box = (over: Partial<AgentElement> = {}): AgentElement => ({
    tag: "textarea",
    role: null,
    type: null,
    label: "Napisz wiadomość",
    inForm: false,
    editable: true,
    ...over,
  });
  // OLX, Vinted and Messenger send on Enter in a text area.
  expect(consequential("enter", box({ buttonsAfter: ["", "Wyślij"] }))).toEqual({
    label: "Wyślij",
  });
  expect(consequential("enter", box({ tag: "div", buttonsAfter: [""] }))).toEqual({
    unlabelled: "beside",
  });
  expect(consequential("enter", box({ buttonsAfter: ["Dodaj zdjęcie", "Emoji"] }))).toBeNull();
  // No button by it at all (Discord's composer): Enter there may send as easily as not. In a form it
  // submits the form, which has no submit button.
  expect(consequential("enter", box())).toEqual({ unlabelled: "beside" });
  expect(consequential("enter", box({ tag: "div", role: "textbox", buttonsAfter: [] }))).toEqual({
    unlabelled: "beside",
  });
  expect(consequential("enter", box({ inForm: true, buttonsAfter: [] }))).toBeNull();
  // shift+Enter is a new line there; in a one-line field it still submits.
  expect(consequential("newline", box({ buttonsAfter: ["Wyślij"] }))).toBeNull();
  const field = box({ tag: "input", type: "text", inForm: true, submitLabel: "Zapłać" });
  expect(consequential("newline", field)).toEqual({ label: "Zapłać" });
  // A search box searches.
  const search = box({ tag: "input", type: "search", search: true, buttonsAfter: [""] });
  expect(consequential("enter", search)).toBeNull();
  // Typing a space types it.
  expect(consequential("space", box({ buttonsAfter: ["Wyślij"] }))).toBeNull();
});

test("Space or Enter on a focused button or link presses it", () => {
  expect(consequential("space", button("Kup teraz"))).toEqual({ label: "Kup teraz" });
  expect(consequential("enter", button("Usuń", { tag: "a" }))).toEqual({ label: "Usuń" });
  expect(consequential("space", button(""))).toEqual({ unlabelled: "button" });
  expect(consequential("enter", button("Dalej"))).toBeNull();
  expect(consequential("space", { ...button(""), tag: "body" })).toBeNull();
  expect(heldBack("space", { label: "Kup teraz" })).toContain('press "Kup teraz"');
  // A new line is shift+Return only in a box that has lines.
  const area: AgentElement = { ...button(""), tag: "textarea", type: null, editable: true };
  const line: AgentElement = { ...area, tag: "input", type: "text" };
  expect(heldBack("enter", { unlabelled: "beside" }, area)).toContain("shift+Return");
  expect(heldBack("enter", { label: "Wyślij" }, area)).toContain("shift+Return");
  expect(heldBack("enter", { unlabelled: "beside" }, line)).not.toContain("shift+Return");
  expect(heldBack("enter", { label: "Zapłać" }, line)).not.toContain("shift+Return");
  expect(heldBack("click", { label: "Wyślij" }, area)).not.toContain("shift+Return");
  // Each says what to do when the step doesn't send or pay, too.
  for (const hold of [{ unlabelled: "beside" as const }, { unseen: true as const }])
    expect(heldBack("enter", hold, area)).toMatch(
      /if it doesn't, reach the same place another way/i,
    );
});

test("a frame Hatbot couldn't enter can't be told apart from a Pay button, so it's held", () => {
  const frame = button("Secure payment", { tag: "iframe", type: null });
  expect(consequential("click", frame)).toEqual({ frame: "Secure payment" });
  expect(consequential("enter", frame)).toEqual({ frame: "Secure payment" });
  // Followed into a payment gateway's frame, any button there is a checkout's.
  const inside = button("Dalej", {
    url: "https://shop.example/koszyk",
    frameUrl: "https://secure.payu.com/front/widget",
  });
  expect(consequential("click", inside)).toEqual({ checkout: "secure.payu.com" });
  // There the frame says more than a label: the tab's address doesn't show the payment.
  const confirm = button("Confirm", {
    url: "https://fundacja.example/wesprzyj",
    frameUrl: "https://js.stripe.com/v3/elements-inner",
  });
  expect(consequential("click", confirm)).toEqual({ checkout: "js.stripe.com" });
  const box = button("", {
    tag: "input",
    type: "text",
    editable: true,
    url: inside.url,
    frameUrl: inside.frameUrl,
  });
  expect(consequential("enter", box)).toEqual({ checkout: "secure.payu.com" });
  expect(heldBack("click", { frame: "" })).toContain("lands in an embedded frame that");
});
