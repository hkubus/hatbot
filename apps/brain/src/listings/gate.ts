// In a listing's desktop task, Publish goes through without asking, once, on that marketplace's
// add-listing page, while the form holds exactly the approved title, description and price.
import { type AgentElement, uploadPage } from "@hatbot/shared/desktop";
import { combosIn, readCombo } from "@hatbot/shared/keys";
import { exact, toAddress, typesText, UNSEEN_MOUSE } from "../negotiate/gate";
import { fold, type Hold, hostOf, onHost } from "../tasks/policy";

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
};

export type ListingCheck =
  | { action: "publish" }
  | { action: "usual" }
  | { action: "hold"; why: string };

/** Short searches and choices beyond the approved text, without links or contact details. */
export const MAX_FREE_TEXT = 60;
const CONTACT = /https?:|www\.|\.(?:pl|com|eu|cz|net)\b|@|\d[\d\s().-]{6,}\d/i;

const PUBLISH =
  /^(?:dodaj|opublikuj|wystaw|publish|post|list|przeslij|upload)(?: (?:ogloszenie|przedmiot|oferte|teraz|za darmo|it|item|listing))*$/;
export const publishLabel = (label: string) => PUBLISH.test(fold(label));

export function samePrice(field: string, price: number): boolean {
  const n = field
    .replace(/\s|zł|zl|pln/gi, "")
    .replace(/,(\d{1,2})$/, ".$1")
    .replace(/[.,](?=\d{3}(?:\D|$))/g, "");
  return /^\d+(?:\.\d{1,2})?$/.test(n) && Number(n) === price;
}

function allowedText(g: ListingGate, text: string): boolean {
  const t = exact(text);
  if (!t || samePrice(t, g.price)) return true;
  if ([g.title, g.description, ...g.choices].some((v) => exact(v) === t)) return true;
  return t.length <= MAX_FREE_TEXT && !CONTACT.test(t);
}

/** What a listing task may never do, before the click and Enter checks. */
export function listingRefused(
  g: ListingGate,
  name: string,
  input: Record<string, unknown>,
): string | null {
  if (UNSEEN_MOUSE.has(name)) return `${name} isn't available in a listing task; use left_click.`;
  const value = name === "form_input" ? input.value : input.text;
  // form_input also takes a number, which could be a phone number.
  const text = typeof value === "string" || typeof value === "number" ? String(value) : "";
  if (name === "type" && /[\r\n]/.test(text))
    return "Put text with line breaks in with form_input, which keeps them: type presses Enter at each.";
  if (typesText(name, input) && !allowedText(g, text))
    return `Type only the approved title, description and price, or a short search or choice (up to ${MAX_FREE_TEXT} characters, with no links, e-mail addresses or phone numbers).`;
  const stay = `A listing task stays on ${g.host}. Open ${g.addUrl} with navigate.`;
  if (name === "navigate") {
    if (typeof input.url !== "string") return "navigate takes the address as text.";
    const where = input.url.trim();
    const url = /^[a-z][a-z0-9+.-]*:/i.test(where) ? where : `https://${where}`;
    const host = hostOf(url);
    if (!["back", "forward", "reload"].includes(where) && !(host && onHost(host, g.host)))
      return stay;
  }
  if (
    (name === "key" || name === "hold_key") &&
    combosIn(text).some((t) => {
      const c = readCombo(t);
      return c !== null && toAddress(c);
    })
  )
    return stay;
  return null;
}

/** `held`: the ordinary check's answer for this element. */
export function listingCheck(
  g: ListingGate,
  kind: "click" | "enter",
  el: AgentElement | null,
  held: Hold | null,
): ListingCheck {
  if (!el?.url || uploadPage(el.url)?.channel !== g.channel) return { action: "usual" };
  // A click or a space in a text box types.
  if (kind === "click" && el.editable) return { action: "usual" };
  const label = kind === "click" ? el.label : held && "label" in held ? held.label : "";
  if (!publishLabel(label)) return { action: "usual" };
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
  const fields = el.fields.map(exact);
  const missing = [
    ...(fields.includes(exact(g.title)) ? [] : ["title"]),
    ...(fields.includes(exact(g.description)) ? [] : ["description"]),
    ...(fields.some((f) => samePrice(f, g.price)) ? [] : ["price"]),
  ];
  if (missing.length)
    return {
      action: "hold",
      why: `The form doesn't hold exactly the approved ${missing.join(", ")}. Make ${missing.length > 1 ? "them" : "it"} exactly as in the task (form_input sets a box's whole text), then publish again.`,
    };
  return { action: "publish" };
}

/** The new listing's address: on the marketplace, and not the add-listing page itself. */
export function listingAddress(g: ListingGate, url: string): string | null {
  const host = hostOf(url);
  if (!/^https:/i.test(url) || !host || !onHost(host, g.host))
    return `That isn't an address on ${g.host}.`;
  if (uploadPage(url)) return "That's the add-listing page, not the new listing's.";
  return null;
}
