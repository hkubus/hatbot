// The desktop's click and Enter checks (PLAN.md §6.1), without a desktop.
import { expect, test } from "bun:test";
import type { AgentElement } from "@hatbot/shared/desktop";
import { consequential, consequentialLabel, fold } from "../src/tasks/policy";

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
  expect(consequential("click", button(""))).toEqual({ unlabelled: true });
  expect(consequential("click", button("➤"))).toEqual({ unlabelled: true });
  expect(consequential("click", button("", { tag: "div", role: "button" }))).toEqual({
    unlabelled: true,
  });
  expect(consequential("click", button("", { tag: "input", type: "image" }))).toEqual({
    unlabelled: true,
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

test("labels are compared folded and with Unicode word edges", () => {
  expect(fold("  ZAPŁAĆ\n teraz ")).toBe("zaplac teraz");
  // \b would see a word edge inside "płać" and "Usuń".
  expect(consequentialLabel("Wypłać")).toBe(true);
  expect(consequentialLabel("Usuńmy")).toBe(false);
  expect(consequentialLabel("zapłata")).toBe(true);
  expect(consequentialLabel("Bezpłatnie")).toBe(false);
});
