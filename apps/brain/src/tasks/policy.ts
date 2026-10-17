// Spots consequential clicks and Enter presses on the desktop (PLAN.md §6.1, screen actions).
import type { AgentElement } from "@hatbot/shared/desktop";

/** Lower case, accents dropped and ł read as l, so "ZAPŁAĆ", "Zapłać" and "Zaplac" match alike. */
export const fold = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/ł/g, "l")
    .replace(/\s+/g, " ")
    .trim();

// JS's \b only knows ASCII letters, so word edges are spelled out: no letter or digit before, or after.
const START = "(?<![\\p{L}\\p{N}])";
const END = "(?![\\p{L}\\p{N}])";
const words = (list: string[]) => new RegExp(`${START}(?:${list.join("|")})`, "iu");

/**
 * Buying, paying, ordering, offering, sending, booking, publishing and account changes, in English, Polish
 * and Czech, folded. Polish and Czech words bend, so most are stems; a stem that would catch a common
 * harmless word ("Kontynuuj zakupy", "Moje zamówienia", "Wysłane") stops short of it.
 */
const STRONG = words([
  // English, whole words.
  `(?:send|post|publish|reply|pay|buy|purchase|order|checkout|check out|book|reserve|transfer|sign up|register|subscribe|unsubscribe|donate|bid|place bid|withdraw|change password)${END}`,
  `(?:make|send|submit) (?:an |a )?offer${END}`,
  `accept (?:the |this )?offer${END}`,
  `(?:proceed|continue|go) to (?:payment|checkout)${END}`,
  `cancel (?:order|subscription|booking|reservation)${END}`,
  // Polish: kupić, Kup teraz, Kupuję i płacę (not kupon).
  "kup(?!on)",
  `zakup(?!y|ow|ach|ami)`,
  // zapłać, zapłata, opłać, wypłać, wpłać, płatność; płać on its own.
  "zaplac",
  "zaplat",
  "oplac",
  "wyplac",
  "wplac",
  "platnos",
  `plac${END}`,
  `zamow(?:ic)?${END}`,
  "zamawiam",
  `zloz(?:yc)?${END}`,
  "(?:za)?akceptuj\\p{L}* ofert",
  "przyjmij ofert",
  "zaproponuj",
  "licytuj",
  "podbij",
  "wyroznij",
  "wystaw",
  `wysl(?:ij|ac|e)${END}`,
  `odesl(?:ij|ac)${END}`,
  `odpowiedz${END}`,
  "(?:o)?publikuj",
  "(?:za)?rezerwuj",
  "zarejestruj",
  "zmien haslo",
  "(?:za)?subskrybuj",
  "anuluj (?:zamowienie|subskrypcj|rezerwacj)",
  "przelej",
  // Czech: koupit, zaplatit (above), platba, objednat, objednávku, nabídnout, poslat, odeslat.
  "koupit",
  "platb",
  `objedn(?:at|ej|ejte|avam)${END}`,
  `objednavk[au]${END}`,
  "dokoncit (?:nakup|objednavk)",
  "prij(?:mout|mete|mi) nabid",
  "nabidn",
  "(?:ucinit|udelat|podat) nabid",
  "poslat",
  "odeslat",
  `(?:posli|odesli)${END}`,
  "odpovedet",
  `odpovez${END}`,
  "(?:za)?rezervov",
  "(?:za)?registrov",
  "publikovat",
  "zverejnit",
  "zrusit (?:objednavk|predplatn|rezervac)",
]);

/** Submitting, confirming, saving and deleting: consequential, except on a filter, sort or search control. */
const SOFT = words([
  `(?:submit|confirm|delete|remove|apply|save changes)${END}`,
  "potwierdz",
  "zatwierdz",
  `usun(?:ac)?${END}`,
  "skasuj",
  "zapisz zmiany",
  "aplikuj",
  "potvrd",
  "potvrzuji",
  "smazat",
  `smaz${END}`,
  `odstran(?:it)?${END}`,
  "ulozit zmeny",
]);

/** Filters, sorting, results and search: "Apply filters", "Usuń filtry", "Seřadit". */
const NARROWING = words([
  "filt",
  "sort",
  "seradit",
  "radit",
  "wynik",
  "vysledk",
  "results",
  "search",
  "szuka",
  "wyszuk",
  "hleda",
  "vyhled",
]);

/** Whether a label names a consequential step. `search`: the control narrows a list (a search form, say). */
export function consequentialLabel(label: string, search = false): boolean {
  const l = fold(label);
  if (!l) return false;
  if (STRONG.test(l)) return true;
  return SOFT.test(l) && !search && !NARROWING.test(l);
}

/** Which check an action needs, if any. */
export function checkFor(name: string, input: Record<string, unknown>): "click" | "enter" | null {
  if (name === "left_click" || name === "double_click" || name === "triple_click") return "click";
  if (
    name === "key" &&
    typeof input.text === "string" &&
    /(^|\+)(return|enter|kp_enter)$/i.test(input.text.trim())
  )
    return "enter";
  if (name === "type" && typeof input.text === "string" && input.text.includes("\n"))
    return "enter";
  return null;
}

/** Payment pages shops hand over to (PayU, Przelewy24, PayPal and the like). */
const PAYMENT_HOSTS =
  /(?:^|\.)(?:payu\.com|przelewy24\.pl|paypal\.com|tpay\.com|paynow\.pl|imoje\.pl|dotpay\.pl|blik\.com|gopay\.cz|gopay\.com|comgate\.cz|checkout\.stripe\.com|adyen\.com)$/i;
/** A checkout or payment step, by the word a part of its address's path starts with. */
const CHECKOUT_PATH =
  /^(?:checkout|finali[sz]e|kasa|platnosci?|payments?|pay|zamowienie|transaction|objednavka|pokladna)(?:$|[-_.])/i;

/** The host of a checkout or payment page, where any click may order or pay; null for other pages. */
export function checkoutHost(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    const parts = fold(decodeURIComponent(u.pathname)).split("/");
    return PAYMENT_HOSTS.test(u.hostname) || parts.some((p) => CHECKOUT_PATH.test(p))
      ? u.hostname
      : null;
  } catch {
    return null;
  }
}

/** Why an element needs confirm_intent: its label, that it has none to go by, or the page it's on. */
export type Hold = { label: string } | { unlabelled: true } | { checkout: string };

/** A button that does something, as opposed to a text box, a link or plain text. */
const buttonLike = (el: AgentElement) =>
  el.tag === "button" ||
  el.role === "button" ||
  (el.tag === "input" && ["submit", "button", "image", "reset"].includes(el.type ?? ""));

/** Whether acting on this element needs confirm_intent first, and why. */
export function consequential(kind: "click" | "enter", el: AgentElement | null): Hold | null {
  if (!el) return null;
  const search = el.search === true;
  const checkout = checkoutHost(el.url);
  if (kind === "enter") {
    // Enter in a form field submits the form; in a textarea it's a new line.
    if (!el.inForm || el.tag === "textarea") return null;
    const label = el.submitLabel ?? "";
    if (consequentialLabel(label, search)) return { label };
    return checkout ? { checkout } : null;
  }
  if (consequentialLabel(el.label, search)) return { label: el.label };
  // At checkout, a button labelled "Dalej" may be the one that orders: only typing and choosing pass.
  if (checkout && !el.editable && !el.toggle && el.tag !== "body") return { checkout };
  if (search) return null;
  if (el.type === "submit" && el.inForm) return { label: el.label || "Submit" };
  // An icon with no name ("➤" counts as none) could be Send or Pay as easily as a menu; one that opens or
  // closes part of the page says so (aria-expanded and the like).
  if (buttonLike(el) && !/[\p{L}\p{N}]/u.test(el.label) && !el.toggle) return { unlabelled: true };
  return null;
}

/** What the model is told when a step is held for confirm_intent. */
export function heldBack(kind: "click" | "enter", hold: Hold): string {
  const act = kind === "click" ? "click" : "Enter";
  if ("label" in hold)
    return `this would ${kind === "click" ? "click" : "submit with"} "${hold.label}", which looks like a consequential step. If that's the action you mean to take, call confirm_intent first. If this ${act} doesn't send, buy, book or delete anything and the label misled the check, reach the same place another way.`;
  if ("checkout" in hold)
    return `this ${act} is on a checkout or payment page (${hold.checkout}), where any button may order or pay, so each one needs the owner. Typing in a field and choosing an option don't. Call confirm_intent first, saying what this ${act} does.`;
  return `this ${act} is on a button with no label, so Hatbot can't tell what it does: it could send or pay as easily as open a menu. If it sends, buys, pays, books or deletes anything, call confirm_intent first. If it doesn't, reach the same place another way: Escape to close something, scrolling, or a labelled control.`;
}
