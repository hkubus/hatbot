// The exact-text send gate (PLAN.md §16.3): in a negotiation's desktop task, a click or Enter goes through
// as the send only while the text boxes hold exactly the approved message and the tab is that
// negotiation's conversation. Pure, so desktop-run and the tests share it.
import type { AgentElement } from "@hatbot/shared/desktop";
import { type Combo, combosIn, readCombo } from "@hatbot/shared/keys";
import {
  consequentialLabel,
  fold,
  type Hold,
  heldWhat,
  type Press,
  pressOf,
} from "../tasks/policy";

/** What a negotiation's desktop task may do, from its record. */
export type SendGate = {
  /** send: may send `text` once. read: reads the conversation and sends nothing. */
  mode: "send" | "read";
  text: string | null;
  listingUrl: string;
  /** The marketplace's id for the listing, from its key. */
  listingId: string;
  conversationUrl: string | null;
};

/** How the gate stands in one run. */
export type GateState = {
  /** record_conversation has been called, so a seller message that came meanwhile has been seen. */
  recorded: boolean;
  /** A send went through: nothing more is sent. */
  sent: boolean;
  /** Why nothing may be sent any more, e.g. the seller wrote since the message was approved. */
  stopped?: string | null;
  /** Something has been typed or pasted: from here a send needs a text box Hatbot can see. */
  typed?: boolean;
};

export type GateCheck =
  /** It's the send: let it through without confirm_intent, then see whether the text went. */
  | { action: "send" }
  /** It can't send anything (a click in a text box): let it through. */
  | { action: "pass" }
  /** The usual consequential-step check decides (PLAN.md §6.1). */
  | { action: "usual" }
  | { action: "hold"; why: string };

/**
 * Text as the gate compares it and the policy reads it: NFKC (fullwidth and other compatibility forms
 * become plain ones), invisible format characters such as soft hyphens dropped, whitespace collapsed.
 */
export const collapse = (s: string) =>
  s
    .normalize("NFKC")
    .replace(/\p{Cf}/gu, "")
    .replace(/\s+/g, " ")
    .trim();

/** A host without "www.", lowercased; null for something that isn't a web address. */
export function hostOf(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return u.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

export const sameHost = (a: string, b: string) => {
  const h = hostOf(a);
  return h !== null && h === hostOf(b);
};

/** `tab` is `want`: the same host and path (a trailing slash aside), with `want`'s query values. */
export function sameAddress(tab: string, want: string): boolean {
  if (!sameHost(tab, want)) return false;
  const a = new URL(tab);
  const b = new URL(want);
  const path = (p: string) => p.replace(/\/+$/, "") || "/";
  if (path(a.pathname) !== path(b.pathname)) return false;
  for (const [k, v] of b.searchParams) if (a.searchParams.get(k) !== v) return false;
  return true;
}

/**
 * The tab shows this negotiation's conversation: the listing (a first message is written there), the
 * conversation recorded for it, or another page on the listing's site whose path names the listing.
 */
export function onConversation(tab: string, gate: SendGate): boolean {
  if (sameAddress(tab, gate.listingUrl)) return true;
  if (gate.conversationUrl && sameAddress(tab, gate.conversationUrl)) return true;
  if (!sameHost(tab, gate.listingUrl) || gate.listingId.length < 5) return false;
  const id = gate.listingId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // In the path only: a query value is anything the model puts there.
  return new RegExp(`[/=-]${id}(?:[/.-]|$)`, "i").test(new URL(tab).pathname);
}

/** Labels a send button has: these pass as the send. Anything else consequential is held. */
const SEND_LIKE =
  /^(send|send message|reply|submit|post|wyślij|wyslij|wyślij wiadomość|odpowiedz|odeślij|odpowiedź|napisz|poslat|odeslat|odeslat zprávu|odpovědět)$/i;
/** A send verb first, folded: "Wyślij wiadomość do sprzedającego", "Send a message". */
const SEND_VERB =
  /^(?:send|reply|wyslij|odpowiedz|odeslij|poslat|odeslat|odpovedet)(?![\p{L}\p{N}])/u;
/** Words that make a send something else: an offer, a price, money or a payment. */
const NOT_A_MESSAGE =
  /(?<![\p{L}\p{N}])(?:offer|ofert|propozycj|nabid|price|cen[aeyu]?(?![\p{L}])|money|pieni|kwot|penize|castk|platb|przelew|blik|faktur|invoice|deposit|zaliczk)/u;

/** A label that sends the message, and nothing else with it. */
export function sendLabel(label: string): boolean {
  if (SEND_LIKE.test(collapse(label))) return true;
  const l = fold(collapse(label));
  const rest = l.replace(SEND_VERB, "");
  return rest !== l && !consequentialLabel(rest) && !NOT_A_MESSAGE.test(rest);
}

/** A link that opens another page: a web address that isn't this one ("#" and javascript: don't). */
function opensPage(href: string, here: string | undefined): boolean {
  try {
    const to = new URL(href);
    if (to.protocol !== "https:" && to.protocol !== "http:") return false;
    to.hash = "";
    const from = new URL(here ?? "");
    from.hash = "";
    return to.href !== from.href;
  } catch {
    return false;
  }
}

/**
 * Which way a click or Enter goes in a negotiation's desktop task. `held`: the ordinary check's answer
 * for this element. A pay or buy button, or any button at checkout, isn't the send, with the text in
 * place or not.
 */
export function gateCheck(
  gate: SendGate,
  state: GateState,
  kind: "click" | "enter",
  el: AgentElement | null,
  held: Hold | null,
): GateCheck {
  if (!el)
    return {
      action: "hold",
      why: "Hatbot couldn't see what this would act on. Take a screenshot and try again, on the element itself.",
    };
  if (!el.fields || el.url === undefined)
    return {
      action: "hold",
      why: "The desktop is out of date and can't show what's in the text boxes, so nothing is sent. The owner needs to update desktop-agent.",
    };
  // The page's box may hold the approved text while Enter goes to an address typed in the address bar.
  if (el.pageFocus === false)
    return {
      action: "hold",
      why: "The keyboard isn't on the page: it's in the address bar or another window. Click into the conversation's message box first.",
    };
  if (el.href && offSite(el.href, gate))
    return {
      action: "hold",
      why: `This link goes to ${el.href.slice(0, 120)}. A negotiation stays on ${hostOf(gate.listingUrl)}: never open a link from the seller.`,
    };
  // Clicking into a text box, or on the page itself, sends nothing; Enter in a box may.
  if (kind === "click" && (el.editable || el.tag === "body")) return { action: "pass" };
  const text = gate.text ? collapse(gate.text) : null;
  const fields = el.fields.map(collapse).filter(Boolean);
  if (!fields.length) {
    // Typed text in a box Hatbot can't see into (a closed shadow root, another site's frame) would go
    // without being compared. Only a link elsewhere on the listing's site needs no box.
    if (
      gate.mode === "send" &&
      state.typed &&
      !state.sent &&
      !(kind === "click" && el.href && opensPage(el.href, el.url))
    )
      return {
        action: "hold",
        why: "Hatbot can't see the text box this would send from, so it can't check the message. Type it into the conversation's own message box, or open the conversation again.",
      };
    return { action: "usual" };
  }
  if (gate.mode === "read" || !text)
    return {
      action: "hold",
      why: "A text box here holds text, and this task only reads the conversation: it sends nothing. Don't click or submit anything with text in a box.",
    };
  if (state.stopped) return { action: "hold", why: state.stopped };
  if (state.sent)
    return {
      action: "hold",
      why: "The message has been sent once already in this task; nothing more goes. Finish the task.",
    };
  if (fields.length !== 1 || fields[0] !== text) {
    const other = fields.find((f) => f !== text) ?? "";
    return {
      action: "hold",
      why: `A text box holds "${other.slice(0, 80)}${other.length > 80 ? "…" : ""}", which isn't exactly the approved message. Clear it or make it exactly the approved text; only that is sent.`,
    };
  }
  if (!el.url || !onConversation(el.url, gate))
    return {
      action: "hold",
      why: `This tab (${el.url || "unknown"}) isn't the negotiation's conversation. Open ${gate.conversationUrl ?? gate.listingUrl} and send it there.`,
    };
  if (!state.recorded)
    return {
      action: "hold",
      why: "Call record_conversation first, with the messages in the conversation, so a reply that came meanwhile isn't missed.",
    };
  // At checkout any button may order or pay; a frame from another address (a payment widget, say)
  // isn't this page's Send.
  if (held && ("checkout" in held || "frame" in held)) return { action: "usual" };
  if (el.tag === "iframe" || el.tag === "frame") return { action: "usual" };
  // Enter in a chat box sends from it, whichever of the buttons by it comes first.
  const chat = kind === "enter" && el.editable && el.tag !== "input";
  if (
    held &&
    "label" in held &&
    !sendLabel(held.label) &&
    !(chat && el.buttonsAfter?.some(sendLabel))
  )
    return { action: "usual" };
  return { action: "send" };
}

/**
 * What the model is told when a step in a negotiation's task would need confirm_intent: it never arms
 * there, so the step can't go.
 */
export function gateHeld(gate: SendGate, press: Press, hold: Hold): string {
  const act = press === "click" ? "click" : press === "space" ? "Space" : "Enter";
  const only =
    gate.mode === "send"
      ? "it only sends the approved message, with the conversation's Send button or Enter while the box holds exactly that text"
      : "it only reads the conversation";
  return `this ${act} ${heldWhat(hold)} would need the owner's approval, and this task can't ask for it: ${only}. If this is in the way, finish and say why.`;
}

/** Enter in a key press: any combo in the sequence, e.g. "shift+Return" or "a Return". */
export const pressesEnter = (keys: string) =>
  keys
    .trim()
    .split(/\s+/)
    .some((combo) => {
      const p = pressOf(combo);
      return p === "enter" || p === "newline";
    });

/**
 * Actions a negotiation's desktop task may not take at all: they could send without the brain seeing
 * the click or the Enter first. Null when it may.
 */
export function refused(
  gate: SendGate,
  name: string,
  input: Record<string, unknown>,
): string | null {
  // A middle click opens a link in a new tab, and a right click a menu that can; on Linux a middle
  // click in a box also pastes.
  if (UNSEEN_MOUSE.has(name)) return `${name} isn't available in a negotiation; use left_click.`;
  const typed = typeof input.text === "string" ? input.text : "";
  if (name === "type" && /[\r\n]/.test(typed))
    return "Type the message without line breaks: it's one paragraph. Send it with the Send button or Enter afterwards.";
  if (gate.mode === "read" && typesText(name, input))
    return "This task only reads the conversation; it doesn't type anything.";
  if (
    (name === "key" || name === "hold_key") &&
    pressesEnter(typed) &&
    Number(input.repeat ?? 1) > 1
  )
    return "Press Enter once.";
  if (
    name === "key" &&
    typed
      .trim()
      .split(/\s+/)
      .some((c) => pressOf(c) === "newline")
  )
    return "The message is one paragraph: no new lines. Send it with the Send button or Enter.";
  const stay = `A negotiation stays on ${hostOf(gate.listingUrl)}. Never open a link from the seller.`;
  if (name === "navigate") {
    // desktop-agent would open whatever this turns into as text.
    if (typeof input.url !== "string") return "navigate takes the address as text.";
    const where = input.url.trim();
    // Read as desktop-agent reads it: an address with no scheme is https.
    const url = /^[a-z][a-z0-9+.-]*:/i.test(where) ? where : `https://${where}`;
    if (
      !["back", "forward", "reload"].includes(where) &&
      (!sameHost(url, gate.listingUrl) || offSite(url, gate))
    )
      return stay;
  }
  // The address bar, new tabs and windows, history and the browser's menus are ways to an address
  // navigate would refuse.
  if (
    (name === "key" || name === "hold_key") &&
    combosIn(typed).some((t) => {
      const c = readCombo(t);
      return c !== null && toAddress(c);
    })
  )
    return `${stay} Use navigate to open a page.`;
  return null;
}

const UNSEEN_MOUSE = new Set([
  "left_mouse_down",
  "left_mouse_up",
  "left_click_drag",
  "middle_click",
  "right_click",
]);

/** F6, ctrl+l, alt+d and the like, with any other modifiers and in any order. */
function toAddress(c: Combo): boolean {
  const k = c.key?.toLowerCase() ?? "";
  if (k === "f6" || k === "f10" || k === "menu") return true;
  if (c.mods.includes("ctrl") && ["l", "t", "n", "k", "e", "h", "j"].includes(k)) return true;
  // alt+shift+t and alt+shift+b move to the toolbar and the bookmarks.
  return c.mods.includes("alt") && ["d", "f", "e", "t", "b", "home"].includes(k);
}

/** A combination that puts text in a box: a character or Space, alone or with Shift, or a paste. */
function typedBy(c: Combo): boolean {
  const k = c.key;
  if (!k) return false;
  if ((k === "space" || [...k].length === 1) && c.mods.every((m) => m === "shift")) return true;
  if (k.toLowerCase() === "v" && (c.mods.includes("ctrl") || c.mods.includes("super"))) return true;
  return k === "insert" && c.mods.includes("shift") && !c.mods.includes("ctrl");
}

/** Whether an action puts text in a box: typing, form_input, keys that type, or a paste. */
export function typesText(name: string, input: Record<string, unknown>): boolean {
  if (name === "type" || name === "form_input") return true;
  if ((name !== "key" && name !== "hold_key") || typeof input.text !== "string") return false;
  return combosIn(input.text).some((t) => {
    const c = readCombo(t);
    return c !== null && typedBy(c);
  });
}

/** Where a link goes, when that's off the listing's site: another host, or another kind of address. */
export function offSite(href: string, gate: SendGate): boolean {
  if (/^javascript:/i.test(href)) return false;
  if (!sameHost(href, gate.listingUrl)) return true;
  // The site's own redirect, to an address in its query (with or without its scheme).
  for (const v of new URL(href).searchParams.values())
    if (
      (/^https?:/i.test(v) || v.startsWith("//")) &&
      !sameHost(v.startsWith("//") ? `https:${v}` : v, gate.listingUrl)
    )
      return true;
  return false;
}
