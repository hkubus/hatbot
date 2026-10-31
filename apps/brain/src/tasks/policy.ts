// Spots consequential clicks and Enter presses on the desktop.

import { pathOf, TRACKING } from "@hatbot/plugin-sdk";
import type { AgentElement } from "@hatbot/shared/desktop";
import { type Combo, combosIn, readCombo } from "@hatbot/shared/keys";

/**
 * Folds case, accents, ł, look-alike letters ("Ｐａｙ") and invisible format characters (a zero-width
 * space inside "Kup"), so "ZAPŁAĆ" and "Zaplac" match alike.
 */
export const fold = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\p{M}\p{Cf}]/gu, "")
    .replace(/ł/g, "l")
    .replace(/\s+/g, " ")
    .trim();

// JS's \b only knows ASCII letters, so word edges are spelled out: no letter or digit before, or after.
const START = "(?<![\\p{L}\\p{N}])";
const END = "(?![\\p{L}\\p{N}])";
const words = (list: string[]) => new RegExp(`${START}(?:${list.join("|")})`, "iu");

const BUY = [
  `(?:pay|payment|buy|purchase|order|checkout|check out|bid|place bid|donate)${END}`,
  `(?:make|send|submit) (?:an |a )?offer${END}|accept (?:the |this )?offer${END}`,
  `(?:proceed|continue|go) to (?:payment|checkout)${END}`,
  // Polish: kupić, Kup teraz, Kupuję i płacę (not kupon, Kupujący or Zakupione, which are tabs).
  `kup(?!on|ujac)|zakup(?!y|ow|ach|ami|ion)`,
  // zapłać, zapłata, opłać, wypłać, wpłać, płatność and going to it, not "Historia płatności".
  `zaplac|zaplat|oplac|wyplac|wplac|platnosc${END}|(?:do|dokonaj|zrealizuj|realizuj) platnosci`,
  // Płać and Płacę on their own or with how: folded they're "plac" (a square, as in "Plac Wolności 1")
  // and "place" (English: "Place" alone, or before a way to pay).
  `place?(?:$| (?:blik|kart|teraz|przelew|online|gotowk|z gory|za))`,
  `do kas[ay]${END}|(?:wykonaj|zlec|zatwierdz)\\p{L}* przelew|przelej`,
  `zamow(?:ic)?${END}|zamawiam|zloz(?:yc)?${END}`,
  "(?:za)?akceptuj\\p{L}* (?:ofert|cen|propozycj)|przyjmij ofert|przyjmuj\\p{L}* ofert",
  "zaproponuj|licytuj",
  `koupit|platb|objedn(?:at|ej|ejte|avam)${END}|objednavk[au]${END}`,
  "dokoncit (?:nakup|objednavk)|prij(?:mout|mete|mi) nabid|nabidn|(?:ucinit|udelat|podat) nabid",
];

/**
 * Polish and Czech words bend, so most are stems; a stem that would catch a common harmless word
 * ("Kontynuuj zakupy", "Moje zamówienia", "Wysłane") stops short of it.
 */
const STRONG = words([
  ...BUY,
  // Not an e-book.
  `(?:send|post|publish|reply|(?<!e\\p{Pd})book|reserve|transfer|sign up|register|subscribe|unsubscribe|withdraw|change password)${END}`,
  `cancel (?:order|subscription|booking|reservation)${END}`,
  // Wystaw lists an offer; Wystawione is the tab of what's listed.
  `podbij|wyroznij|wystaw(?!ion|ian)|wysl(?:ij|ac|e)${END}|wysylam${END}|odesl(?:ij|ac)${END}|odpowiedz${END}`,
  "(?:o)?publikuj|(?:za)?rezerwuj|zarejestruj|zmien haslo|(?:za)?subskrybuj",
  "anuluj (?:zamowienie|subskrypcj|rezerwacj)",
  `poslat|odeslat|(?:posli|odesli)${END}|odpovedet|odpovez${END}`,
  "(?:za)?rezervov|(?:za)?registrov|publikovat|zverejnit",
  "zrusit (?:objednavk|predplatn|rezervac)",
]);
const BUYING = words(BUY);

/** Nouns that fold into a verb: "Odpowiedź" (an answer) reads as "Odpowiedz" (reply) without its accent. */
const NOUNS = /(?<![\p{L}\p{N}])odpowiedź(?![\p{L}\p{N}])/giu;
const read = (label: string) => fold(label.normalize("NFC").replace(NOUNS, " "));

export const buyingLabel = (label: string) => BUYING.test(read(label));

const SOFT = words([
  `(?:submit|confirm|delete|remove|apply|save changes)${END}`,
  `potwierdz|zatwierdz|usun(?:ac)?${END}|skasuj|zapisz zmiany|aplikuj`,
  `potvrd|potvrzuji|smazat|smaz${END}|odstran(?:it)?${END}|ulozit zmeny`,
]);

const NARROWING = words([
  "filt|sort|seradit|radit|wynik|vysledk|results|search|szuka|wyszuk|hleda|vyhled",
]);

/** A cookie banner's choices ("Confirm my choices") aren't consequential. */
const CONSENT = words([
  "choices|preferences|cookie|consent|wybor|preferencj|zgod|ciasteczk|prywatnos|vyber|predvolb|souhlas",
]);

export const narrowingLabel = (label: string) =>
  NARROWING.test(read(label)) && !STRONG.test(read(label));

/** `search`: the control narrows a list (a search form, say). */
export function consequentialLabel(label: string, search = false): boolean {
  const l = read(label);
  if (!l) return false;
  if (STRONG.test(l)) return true;
  return SOFT.test(l) && !search && !NARROWING.test(l) && !CONSENT.test(l);
}

const CARD_WORDS = 8;

/**
 * A link to another page whose text is a card or a headline ("Sony WH-1000XM5 … Kup teraz") only opens
 * that page, so its words don't hold it. One that stays on the page (href="#") is read as a button.
 */
const card = (el: AgentElement) =>
  !!el.href &&
  !!el.url &&
  /^https?:/i.test(el.href) &&
  !samePage(el.href, el.url) &&
  fold(el.label).split(" ").length > CARD_WORDS;

export type Where =
  | { x: number; y: number }
  | { ref: string }
  | { cursor: true }
  | { focused: true };
/** "newline" is shift+Enter: a new line in a text area. */
export type Press = "click" | "enter" | "newline" | "space";
export type Check = { press: Press; at: Where[] } | { refuse: string };

export function pressOfCombo(c: Combo): Press | null {
  if (c.key === "enter") return c.mods.length === 1 && c.mods[0] === "shift" ? "newline" : "enter";
  return c.key === "space" ? "space" : null;
}

/** Null too for a name readCombo can't read, which checkFor refuses. */
export function pressOf(combo: string): Press | null {
  const c = readCombo(combo);
  return c && pressOfCombo(c);
}

const coordinate = (v: unknown): Where | null =>
  Array.isArray(v) && typeof v[0] === "number" && typeof v[1] === "number"
    ? { x: v[0], y: v[1] }
    : null;
/** A browser toolset target: { type: "ref", ref } or { type: "coordinate", x, y }. */
const target = (v: unknown): Where | null => {
  const t = v as { type?: string; ref?: unknown; x?: unknown; y?: unknown } | undefined;
  if (t?.type === "ref" && typeof t.ref === "string") return { ref: t.ref };
  if (t?.type === "coordinate" && typeof t.x === "number" && typeof t.y === "number")
    return { x: t.x, y: t.y };
  return null;
};

// A middle click opens a link in a new tab, or on Linux pastes into a box: checked where it lands too.
const CLICKS = new Set([
  "left_click",
  "middle_click",
  "double_click",
  "triple_click",
  "left_mouse_down",
  "left_mouse_up",
]);

/**
 * Both ends of a drag are checked, since either can be the click. A key sequence that presses Enter or
 * Space after other keys is refused: what it acts on can't be seen first.
 */
export function checkFor(
  toolset: "computer" | "browser",
  name: string,
  input: Record<string, unknown>,
): Check | null {
  const browser = toolset === "browser";
  // Its menu is a window of the browser's own, over the page: a click on one of its items would be
  // checked against the page under it.
  if (name === "right_click")
    return {
      refuse:
        "A right click opens the browser's menu, and Hatbot can't see what its items do. Use left_click, or a key shortcut.",
    };
  if (CLICKS.has(name)) {
    const at = browser
      ? target(input.target)
      : name.startsWith("left_mouse")
        ? null
        : coordinate(input.coordinate);
    // A browser click without a target fails on its own.
    if (browser && !at) return null;
    return { press: "click", at: [at ?? { cursor: true }] };
  }
  if (name === "left_click_drag") {
    const ends = browser
      ? [target(input.from), target(input.target)]
      : [coordinate(input.start_coordinate), coordinate(input.coordinate)];
    return { press: "click", at: ends.filter((w): w is Where => w !== null) };
  }
  const text = typeof input.text === "string" ? input.text : "";
  if (name === "key" || name === "hold_key") {
    const combos = combosIn(text);
    // A name Hatbot can't read could be Enter under another name (a keycode, a hex keysym).
    const unread = combos.find((c) => !readCombo(c));
    if (unread !== undefined)
      return {
        refuse: `Hatbot can't read the key "${unread}", so it can't check what it presses. Use a key's name (Return, Tab, Page_Down, F5) or a character, with modifiers first: ctrl+shift+t.`,
      };
    const press = combos.map(pressOf).find((p) => p !== null);
    if (!press) return null;
    if (name === "hold_key")
      return { refuse: "Holding Enter or Space repeats it. Press it once, with key." };
    if (combos.length > 1)
      return {
        refuse:
          "Press Enter or Space in a key action of its own, so Hatbot can check what it acts on first.",
      };
    if (Number(input.repeat ?? 1) > 1)
      return { refuse: "Press Enter or Space once, and look before pressing it again." };
    return { press, at: [{ focused: true }] };
  }
  if (name === "type") {
    // Typed into the address bar, these run in the page that's open, logged in. The browser toolset types
    // only into pages, and an address has no space after its colon, as "Data: 15 października" does.
    if (!browser && /^\s*(?:javascript|data|vbscript):\S/i.test(text))
      return {
        refuse:
          "Hatbot doesn't type javascript:, data: or vbscript: addresses: in the address bar they run in the page. Use the browser's navigate to open a web address.",
      };
    if (/\t[\s\S]*[ \r\n]/.test(text))
      return {
        refuse:
          "A tab in typed text moves to another control, and a space or line break after it could press a button there. Type into one field at a time.",
      };
    if (/[\r\n]/.test(text)) return { press: "enter", at: [{ focused: true }] };
    if (text.includes(" ")) return { press: "space", at: [{ focused: true }] };
  }
  return null;
}

export function hostOf(url: string | null | undefined): string | null {
  try {
    const u = new URL(url ?? "");
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return u.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

export const onHost = (host: string, domain: string) =>
  host === domain || host.endsWith(`.${domain}`);

export function samePage(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const page = (s: string) => {
    const u = new URL(s);
    const query = [...u.searchParams].filter(([k]) => !TRACKING.test(k)).map((p) => p.join("="));
    return `${u.origin}${pathOf(u.pathname)}?${query.sort().join("&")}`;
  };
  try {
    return page(a) === page(b);
  } catch {
    return a === b;
  }
}

const PAYMENT_HOSTS = (
  "payu.com payu.pl przelewy24.pl paypal.com tpay.com paynow.pl imoje.pl dotpay.pl blik.com " +
  "autopay.pl bluemedia.pl gopay.cz gopay.com comgate.cz checkout.stripe.com buy.stripe.com " +
  "js.stripe.com hooks.stripe.com adyen.com klarna.com checkout.com braintreegateway.com pay.google.com"
).split(" ");

export function paymentHost(host: string): boolean {
  const h = host.toLowerCase();
  return PAYMENT_HOSTS.some((p) => onHost(h, p));
}
/**
 * A checkout or payment step, by the word a part of its address's path starts with (Shopify's checkouts
 * too), or that is the whole part: order and order1.php (PrestaShop, IdoSell), buy (Amazon's /gp/buy/).
 */
const CHECKOUT_PATH =
  /^(?:(?:checkouts?|finali[sz]e|kasa|platnosci?|payments?|pay|zamowienie|transaction|objednavka|pokladna)(?:$|[-_.])|(?:order\d*|buy)(?:\.\w+)?$)/i;
/** Shops that route by the query instead: OpenCart's route=checkout/…, PrestaShop's controller=order. */
const CHECKOUT_QUERY = ["route", "controller", "step", "fc"];
const CHECKOUT_ROUTE =
  /^(?:checkout|order(?!s|-detail|-history)|payment|platnosc|zamowienie|kasa|objednavka)/i;

export function checkoutHost(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    const parts = fold(decodeURIComponent(u.pathname)).split("/");
    const routed = CHECKOUT_QUERY.some((k) =>
      fold(u.searchParams.get(k) ?? "")
        .split("/")
        .some((p) => CHECKOUT_ROUTE.test(p)),
    );
    return paymentHost(u.hostname) || routed || parts.some((p) => CHECKOUT_PATH.test(p))
      ? u.hostname
      : null;
  } catch {
    return null;
  }
}

/**
 * Why an element needs confirm_intent. `beside`: the button beside a text box that Enter would press;
 * `frame`: a frame Hatbot couldn't get into, named by its title.
 */
export type Hold =
  /** `judged`: the small model's words for what a screenshot shows, not a label on the screen. */
  | { label: string; judged?: true }
  | { unlabelled: "button" | "beside" }
  | { checkout: string }
  | { frame: string }
  | { unseen: true }
  /** Enter or Space with the keyboard off the page: in the address bar, where it opens what's typed. */
  | { outside: true };

const buttonLike = (el: AgentElement) =>
  el.tag === "button" ||
  el.role === "button" ||
  // A div or icon the page made clickable (desktop-agent says so).
  el.role === "clickable" ||
  (el.tag === "input" && ["submit", "button", "image", "reset"].includes(el.type ?? ""));

/** An older desktop-agent doesn't say, so it goes by the tag. */
const editable = (el: AgentElement) =>
  el.editable ??
  (el.tag === "textarea" ||
    (el.tag === "input" &&
      !["submit", "button", "image", "reset", "checkbox", "radio"].includes(el.type ?? "")));
/** No name, or only a symbol ("➤"). */
const nameless = (label: string) => !/[\p{L}\p{N}]/u.test(label);

export function consequential(press: Press, el: AgentElement | null): Hold | null {
  if (!el || el.tag === "body") return null;
  // Payment and chat widgets live in frames from another address.
  if (el.tag === "iframe" || el.tag === "frame") return { frame: el.label };
  // In a checkout or payment frame the tab's address doesn't show it, so the hold does, whatever the
  // label: then it asks as a purchase or payment, and nothing else approved covers it.
  const framed = checkoutHost(el.frameUrl);
  const hold = pressed(press, el, framed ?? checkoutHost(el.url));
  return hold && framed ? { checkout: framed } : hold;
}

function pressed(press: Press, el: AgentElement, checkout: string | null): Hold | null {
  const search = el.search === true;
  // Enter or Space on a button or link presses it, like a click.
  if (!editable(el)) return clicked(el, search, checkout);
  // A click or a space in a text box types; so does shift+Enter in a text area, in chat boxes too.
  if (press === "click" || press === "space" || (press === "newline" && el.tag !== "input"))
    return null;
  // Enter in a text box submits its form, or sends from a chat box through the button after it.
  const labels = [
    ...(el.inForm && el.tag === "input" && el.submitLabel !== undefined ? [el.submitLabel] : []),
    ...(el.buttonsAfter ?? []),
  ];
  const named = labels.find((l) => consequentialLabel(l, search));
  if (named !== undefined) return { label: named };
  if (checkout && (el.inForm || labels.length)) return { checkout };
  if (search) return null;
  // A chat box with no button Hatbot can see by it (Discord's) sends on Enter as easily as not.
  if (!labels.length) return el.inForm ? null : { unlabelled: "beside" };
  return labels.some(nameless) ? { unlabelled: "beside" } : null;
}

function clicked(el: AgentElement, search: boolean, checkout: string | null): Hold | null {
  // A select's text is all its options.
  if (el.tag !== "select" && !card(el) && consequentialLabel(el.label, search))
    return { label: el.label };
  // At checkout, a button labelled "Dalej" may be the one that orders: only typing and choosing pass.
  if (checkout && !el.toggle) return { checkout };
  if (search) return null;
  if (el.type === "submit" && el.inForm) return { label: el.label || "Submit" };
  // An icon with no name could be Send or Pay as easily as a menu; one that opens or closes part of the
  // page says so (aria-expanded and the like).
  if (buttonLike(el) && nameless(el.label) && !el.toggle) return { unlabelled: "button" };
  return null;
}

export function heldWhat(hold: Hold): string {
  if ("label" in hold) return `on "${hold.label}"`;
  if ("checkout" in hold) return `on a checkout page (${hold.checkout})`;
  if ("frame" in hold) return "in an embedded frame";
  if ("unseen" in hold) return "on something Hatbot couldn't see";
  if ("outside" in hold) return "with the keyboard off the page";
  return hold.unlabelled === "beside"
    ? "beside a button with no label"
    : "on a button with no label";
}

/** `el`: what Enter was pressed in, when shift+Return there would be a new line instead. */
export function heldBack(press: Press, hold: Hold, el: AgentElement | null = null): string {
  const act = press === "click" ? "click" : press === "space" ? "Space" : "Enter";
  const newLine =
    press === "enter" && el && el.tag !== "input" && editable(el)
      ? " If you only meant a new line in this box, press shift+Return."
      : "";
  if ("label" in hold)
    return `this would ${press === "click" ? "click" : press === "space" ? "press" : "submit with"} "${hold.label}", which looks like a consequential step. If that's the action you mean to take, call confirm_intent first. If this ${act} doesn't send, buy, book or delete anything and the label misled the check, reach the same place another way.${newLine}`;
  if ("checkout" in hold)
    return `this ${act} is on a checkout or payment page (${hold.checkout}), where any button may order or pay, so each one needs the owner. Typing in a field and choosing an option don't. Call confirm_intent first, saying what this ${act} does.`;
  if ("frame" in hold)
    return `this ${act} lands in an embedded frame${hold.frame ? ` ("${hold.frame}")` : ""} that Hatbot can't see into, so it can't tell what it does; payment and chat widgets live in frames. If it pays, sends, books or deletes anything, call confirm_intent first. If it doesn't, reach the same place another way.`;
  if ("unseen" in hold)
    return `Hatbot couldn't see what this ${act} would act on, so it can't tell whether it's safe. Take a screenshot or read the page again and retry. If it still can't, and this pays, sends, books or deletes anything, call confirm_intent first; if it doesn't, reach the same place another way.`;
  if ("outside" in hold)
    return `the keyboard isn't on the page: it's in the browser's address bar or another window, where ${press === "space" ? "Space may press" : "Enter opens what was typed, or presses"} something Hatbot can't see. To open a page, use the browser's navigate; to type in the page, click into its box first. If this answers a dialog you mean to answer, call confirm_intent first.`;
  if (hold.unlabelled === "beside")
    return `Enter here could send what's in this box, through a button beside it that has no label or none Hatbot can see, so Hatbot can't tell what it does. If it sends, buys, pays, books or deletes anything, call confirm_intent first. If it doesn't, reach the same place another way, such as a labelled button.${newLine}`;
  return `this ${act} is on a button with no label, so Hatbot can't tell what it does: it could send or pay as easily as open a menu. If it sends, buys, pays, books or deletes anything, call confirm_intent first. If it doesn't, reach the same place another way: Escape to close something, scrolling, or a labelled control.`;
}
