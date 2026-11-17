// In a listing's desktop task, Publish goes through without asking, once (again if the site refused
// it), on that marketplace's add-listing page, while the form holds exactly the approved title,
// description and price (on a summary page with no form, while it shows them). The rest of that form
// goes through too, but for anything that may cost money, and any other button that may post or send.
import { type AgentElement, uploadPage } from "@hatbot/shared/desktop";
import { combosIn, readCombo } from "@hatbot/shared/keys";
import { exact, toAddress, typesText, UNSEEN_MOUSE } from "../negotiate/gate";
import {
  buyingLabel,
  fold,
  type Hold,
  hostOf,
  onHost,
  samePage,
  strongLabel,
} from "../tasks/policy";

export type ListingGate = {
  channel: string;
  /** The marketplace's domain, e.g. olx.pl. */
  host: string;
  /** Where the task starts: the add-listing page. */
  addUrl: string;
  title: string;
  description: string;
  price: number;
  /** Other words the brief gives it to pick: the category and the condition. */
  choices: string[];
  photos: number;
  stage: string;
  published: boolean;
  /** The form last seen with the title in held the approved description too. */
  described?: boolean;
};

export type ListingCheck =
  | { action: "publish" }
  | { action: "fill" }
  | { action: "usual" }
  | { action: "hold"; why: string };

/** Short searches and choices beyond the approved text, without links or contact details. */
export const MAX_FREE_TEXT = 60;
const CONTACT = /https?:|www\.|\.(?:pl|com|eu|cz|net)\b|@|\d[\d\s().-]{6,}\d/i;

const PUBLISH =
  /^(?:(?:dodaj|opublikuj|wystaw|publish|post|list|przeslij|upload)(?: (?:ogloszenie|przedmiot|oferte|teraz|za darmo|it|item|listing))*|wystaw jako (?:ogloszenie zwykle|kup teraz|licytacja))$/;
export const publishLabel = (label: string) => PUBLISH.test(fold(label));

/** Paid extras offered while listing: promotions, bumps and packages. */
const PAID =
  /(?<![\p{L}\p{N}])(?:podbij|wyroznij|wyroznien|promuj|promow|promot|pakiet|bump|boost)/u;

/** Turning the extra down ("Nie chcę wyróżniać Zapłacisz: 0 zł"), or a price of nothing for what isn't one. */
const DECLINE = /^(?:nie chce|nie,? dziekuje|bez )/;
const NOTHING =
  /(?<![\p{L}\p{N}])(?:0(?:[.,]0+)? ?(?:zl|pln)(?![\p{L}])|za darmo|bezplatn|darmow)/u;

function free(label: string): boolean {
  const l = fold(label);
  if (/(?!0)\p{N}/u.test(l)) return false;
  return DECLINE.test(l) || (NOTHING.test(l) && !PAID.test(l));
}

function mayCost(held: Hold | null, labels: string[]): boolean {
  if (held && !("label" in held) && !("unlabelled" in held)) return true;
  return [...labels, held && "label" in held ? held.label : ""].some(
    (l) => !free(l) && (buyingLabel(l) || PAID.test(fold(l))),
  );
}

export function samePrice(field: string, price: number): boolean {
  const n = field
    .replace(/\s|zł|zl|pln/gi, "")
    .replace(/,(\d{1,2})$/, ".$1")
    .replace(/[.,](?=\d{3}(?:\D|$))/g, "");
  return /^\d+(?:\.\d{1,2})?$/.test(n) && Number(n) === price;
}

/** Vinted refuses a title with "too many capital letters", so one in other capitals is still the title. */
const caseless = (s: string) => exact(s).toLowerCase();
const isTitle = (g: ListingGate) => (field: string) => caseless(field) === caseless(g.title);

function allowedText(g: ListingGate, text: string): boolean {
  const t = exact(text);
  if (!t || samePrice(t, g.price) || isTitle(g)(t)) return true;
  if ([g.description, ...g.choices].some((v) => exact(v) === t)) return true;
  return t.length <= MAX_FREE_TEXT && !CONTACT.test(t);
}

/** What a listing task may never do, before the click and Enter checks. */
export function listingRefused(
  g: ListingGate,
  name: string,
  input: Record<string, unknown>,
): string | null {
  // A drag reorders photos; both its ends are checked like clicks.
  if (UNSEEN_MOUSE.has(name) && name !== "left_click_drag")
    return `${name} isn't available in a listing task; use left_click.`;
  const value = name === "form_input" ? input.value : input.text;
  // form_input also takes a number, which could be a phone number.
  const text = typeof value === "string" || typeof value === "number" ? String(value) : "";
  if (name === "type" && /[\r\n]/.test(text))
    return "Put text with line breaks in with form_input, which keeps them: type presses Enter at each.";
  if (typesText(name, input) && !allowedText(g, text))
    return `Type only the approved title, description and price, or a short search or choice (up to ${MAX_FREE_TEXT} characters, with no links, e-mail addresses or phone numbers).`;
  if (name === "navigate" && typeof input.url !== "string")
    return "navigate takes the address as text.";
  return leaves(g.host, name, input, text)
    ? `A listing task stays on ${g.host}. Open ${g.addUrl} with navigate.`
    : null;
}

const withScheme = (where: string) =>
  /^[a-z][a-z0-9+.-]*:/i.test(where) ? where : `https://${where}`;

/** Off `host`, by its address or the browser's own bar. */
function leaves(host: string, name: string, input: Record<string, unknown>, text: string): boolean {
  if (name === "navigate") {
    if (typeof input.url !== "string") return false;
    const where = input.url.trim();
    const to = hostOf(withScheme(where));
    return !["back", "forward", "reload"].includes(where) && !(to && onHost(to, host));
  }
  return (
    (name === "key" || name === "hold_key") &&
    combosIn(text).some((t) => {
      const c = readCombo(t);
      return c !== null && toAddress(c);
    })
  );
}

/** "Cena: 229,99 zł" on a page that sums the listing up, or "Cena wywoławcza: …". */
const PRICE_SHOWN = /(?<![\p{L}])cena(?: \p{L}+)?:? ?(\d[\d .,]*?) ?(?:zl|pln)(?![\p{L}])/gu;

// desktop-agent sends a box's first 4000 characters.
const descriptions = (g: ListingGate) => [
  exact(g.description),
  exact(exact(g.description).slice(0, 4000)),
];

/** What a page with no boxes, such as Allegro Lokalnie's summary, doesn't show as approved. */
function notShown(g: ListingGate, text: string): string[] {
  const prices = [...fold(text).matchAll(PRICE_SHOWN)].map((m) => m[1] ?? "");
  return [
    ...(caseless(text).includes(caseless(g.title)) ? [] : ["title"]),
    // It's typed in the form, and a summary may not show it.
    ...(g.described ? [] : ["description"]),
    ...(prices.length && prices.every((p) => samePrice(p, g.price)) ? [] : ["price"]),
  ];
}

/**
 * `held`: the ordinary check's answer for this element. `pageText`: the tab's text, for a publish on a
 * page with no boxes.
 */
export async function listingCheck(
  g: ListingGate,
  kind: "click" | "enter",
  el: AgentElement | null,
  held: Hold | null,
  pageText: () => Promise<string | null> = async () => null,
): Promise<ListingCheck> {
  if (!el?.url || uploadPage(el.url)?.channel !== g.channel) return { action: "usual" };
  const fields = el.fields?.map(exact) ?? [];
  if (fields.some(isTitle(g))) g.described = fields.some((f) => descriptions(g).includes(f));
  // A click or a space in a text box types.
  if (kind === "click" && el.editable) return { action: "usual" };
  // Enter in a box submits its form or presses the button after it, which the ordinary check may not hold.
  const labels =
    kind === "click" || !el.editable
      ? [el.label]
      : [
          held && "label" in held ? held.label : "",
          ...(el.inForm && el.submitLabel ? [el.submitLabel] : []),
          ...(el.buttonsAfter ?? []),
        ];
  if (!labels.some(publishLabel)) {
    // A checkout, a frame (perhaps a payment widget), or something Hatbot couldn't see asks as usual.
    if (mayCost(held, labels)) return { action: "usual" };
    // A publish button it doesn't know would post past the check below.
    const acts = labels.find((l) => strongLabel(l) && !buyingLabel(l) && !PAID.test(fold(l)));
    return acts === undefined
      ? { action: "fill" }
      : {
          action: "hold",
          why: `"${acts}" may post or send something, and it isn't a publish button the listing's check knows, so a listing task doesn't press it. If the site publishes with it, finish and say so.`,
        };
  }
  // A promotion or payment step in a frame, or a checkout, asks as it always does.
  if (held && ("checkout" in held || "frame" in held)) return { action: "usual" };
  if (g.published)
    return {
      action: "hold",
      why: "It was published once in this task already; nothing more is posted. Call record_listing with the new listing's address, then finish.",
    };
  if (!el.fields)
    return {
      action: "hold",
      why: "The desktop is out of date and can't show what's in the form, so nothing is published. The owner needs to update desktop-agent.",
    };
  if (!fields.length) {
    const missing = notShown(g, (await pageText()) ?? "");
    if (missing.length)
      return {
        action: "hold",
        why: `Publishing from a page with no form needs it to show exactly the approved title and price, and the form to have held exactly the approved description when you last moved on from it with its own button. The ${missing.join(", ")} ${missing.length > 1 ? "aren't" : "isn't"}. Go back to the form, make ${missing.length > 1 ? "them" : "it"} exactly as in the task, move on with its buttons, then publish again.`,
      };
    return { action: "publish" };
  }
  const missing = [
    ...(fields.some(isTitle(g)) ? [] : ["title"]),
    ...(fields.some((f) => descriptions(g).includes(f)) ? [] : ["description"]),
    ...(fields.some((f) => samePrice(f, g.price)) ? [] : ["price"]),
  ];
  if (missing.length)
    return {
      action: "hold",
      why: `The form doesn't hold exactly the approved ${missing.join(", ")}. Make ${missing.length > 1 ? "them" : "it"} exactly as in the task (form_input sets a box's whole text), then publish again.`,
    };
  return { action: "publish" };
}

/**
 * After Publish: still its add-listing form with the title in, or still the page with no form it was
 * pressed on, so the site didn't take it.
 */
export function stillInForm(
  g: ListingGate,
  el: AgentElement | null | undefined,
  from: AgentElement | null,
): boolean {
  if (!el?.fields || uploadPage(el.url)?.channel !== g.channel) return false;
  if (!from?.fields?.length) return samePage(el.url, from?.url);
  return el.fields.some(isTitle(g));
}

/** The new listing's address: on the marketplace, and not the add-listing page itself. */
export function listingAddress(g: ListingGate, url: string): string | null {
  const host = hostOf(url);
  if (!/^https:/i.test(url) || !host || !onHost(host, g.host))
    return `That isn't an address on ${g.host}.`;
  if (uploadPage(url)) return "That's the add-listing page, not the new listing's.";
  return null;
}

/** A sold flip's listing coming down: its task stays on that marketplace and posts nothing. */
export type TakeDownGate = {
  channel: string;
  host: string;
  /** The listing Hatbot posted, where the task starts. */
  url: string;
  title: string;
};

/** What a take-down task may never do, before the click and Enter checks. */
export function takeDownRefused(
  g: TakeDownGate,
  name: string,
  input: Record<string, unknown>,
): string | null {
  if (UNSEEN_MOUSE.has(name)) return `${name} isn't available in a take-down task; use left_click.`;
  const value = name === "form_input" ? input.value : input.text;
  const text = typeof value === "string" || typeof value === "number" ? String(value) : "";
  if (typesText(name, input)) {
    const t = exact(text);
    if (t && t !== exact(g.title) && (t.length > MAX_FREE_TEXT || CONTACT.test(t)))
      return `Type only the listing's title, or a short search or choice (up to ${MAX_FREE_TEXT} characters, with no links, e-mail addresses or phone numbers).`;
  }
  if (name === "navigate" && typeof input.url !== "string")
    return "navigate takes the address as text.";
  if (leaves(g.host, name, input, text))
    return `A take-down task stays on ${g.host}. Open ${g.url} with navigate.`;
  if (name === "navigate" && uploadPage(withScheme(String(input.url).trim())))
    return "A take-down task posts nothing: stay off the add-listing page.";
  return null;
}

/** A click or Enter on the add-listing page posts something, which a take-down task never does. */
export function takeDownCheck(el: AgentElement | null, lastUrl: string | null): string | null {
  return uploadPage(el?.url ?? lastUrl)
    ? "A take-down task posts nothing: stay off the add-listing page."
    : null;
}
