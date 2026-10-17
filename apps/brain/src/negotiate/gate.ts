// The exact-text send gate (PLAN.md §16.3): in a negotiation's desktop task, a click or Enter goes through
// as the send only while the text boxes hold exactly the approved message and the tab is that
// negotiation's conversation. Pure, so desktop-run and the tests share it.
import type { AgentElement } from "@hatbot/shared/desktop";
import { pressOf } from "../tasks/policy";

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
};

export type GateCheck =
  /** It's the send: let it through without confirm_intent, then see whether the text went. */
  | { action: "send" }
  /** It can't send anything (a click in a text box): let it through. */
  | { action: "pass" }
  /** The usual consequential-step check decides (PLAN.md §6.1). */
  | { action: "usual" }
  | { action: "hold"; why: string };

/** Text as the gate compares it: Unicode-normalised, invisible characters dropped, whitespace collapsed. */
export const collapse = (s: string) =>
  s.normalize("NFC").replace(/[​-‍⁠﻿]/g, "").replace(/\s+/g, " ").trim();

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
 * conversation recorded for it, or another page on the listing's site whose address names the listing.
 */
export function onConversation(tab: string, gate: SendGate): boolean {
  if (sameAddress(tab, gate.listingUrl)) return true;
  if (gate.conversationUrl && sameAddress(tab, gate.conversationUrl)) return true;
  if (!sameHost(tab, gate.listingUrl) || gate.listingId.length < 5) return false;
  const id = gate.listingId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`[/=-]${id}(?:[/?&#.-]|$)`, "i").test(
    new URL(tab).pathname + new URL(tab).search,
  );
}

/** Labels a send button has: these pass as the send. Anything else consequential needs confirm_intent. */
const SEND_LIKE =
  /^(send|send message|reply|submit|post|wyślij|wyslij|wyślij wiadomość|odpowiedz|odeślij|odpowiedź|napisz|poslat|odeslat|odeslat zprávu|odpovědět)$/i;

/**
 * Which way a click or Enter goes in a negotiation's desktop task. `consequentialLabel` is the ordinary
 * check's answer for this element: a pay or buy button still needs confirm_intent with the text in place.
 */
export function gateCheck(
  gate: SendGate,
  state: GateState,
  kind: "click" | "enter",
  el: AgentElement | null,
  consequentialLabel: string | null,
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
  // Clicking into a text box sends nothing; Enter in one may.
  if (kind === "click" && el.editable) return { action: "pass" };
  const text = gate.text ? collapse(gate.text) : null;
  const fields = el.fields.map(collapse).filter(Boolean);
  if (!fields.length) return { action: "usual" };
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
  if (consequentialLabel && !SEND_LIKE.test(collapse(consequentialLabel)))
    return { action: "usual" };
  return { action: "send" };
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
  if (name === "left_mouse_down" || name === "left_mouse_up" || name === "left_click_drag")
    return `${name} isn't available in a negotiation; use left_click.`;
  const typed = typeof input.text === "string" ? input.text : "";
  if (name === "type" && /[\r\n]/.test(typed))
    return "Type the message without line breaks: it's one paragraph. Send it with the Send button or Enter afterwards.";
  if (gate.mode === "read" && (name === "type" || name === "form_input"))
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
  if (name === "navigate" && typeof input.url === "string" && /^https?:/i.test(input.url)) {
    if (!sameHost(input.url, gate.listingUrl))
      return `A negotiation stays on ${hostOf(gate.listingUrl)}. Never open a link from the seller.`;
  }
  return null;
}
