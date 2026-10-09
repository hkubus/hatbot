// Spots consequential clicks and Enter presses on the desktop (PLAN.md §6.1, screen actions).
import type { AgentElement } from "@hatbot/shared/desktop";

const CONSEQUENTIAL =
  /\b(submit|send|post|publish|reply|pay|buy|purchase|order|checkout|check out|book|reserve|confirm|delete|remove|transfer|sign up|register|subscribe|unsubscribe|donate|apply|save changes|change password)\b/i;

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

/** The label that makes this element consequential, or null. */
export function consequential(kind: "click" | "enter", el: AgentElement | null): string | null {
  if (!el) return null;
  if (kind === "enter") {
    // Enter in a form field submits the form; in a textarea it's a new line.
    if (!el.inForm || el.tag === "textarea") return null;
    const label = el.submitLabel ?? "";
    return CONSEQUENTIAL.test(label) ? label : null;
  }
  if (CONSEQUENTIAL.test(el.label)) return el.label;
  if (el.type === "submit" && el.inForm) return el.label || "Submit";
  return null;
}
