// Messages to sellers go through a negotiation: its mandate, and the exact-text gate (PLAN.md §16.3).
// A desktop task that isn't one asks first before a click or Enter that could send what's in a text box
// on a marketplace, whatever the button is called; an icon-only Send has no label to catch.
import type { AgentElement } from "@hatbot/shared/desktop";
import { narrowingLabel } from "../tasks/policy";

/** The marketplaces negotiations run on. */
export const MARKETPLACE_HOSTS = ["olx.pl", "allegrolokalnie.pl", "vinted.pl"];

/** The marketplace a page is on, or null. */
export function marketplaceOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return MARKETPLACE_HOSTS.find((h) => host === h || host.endsWith(`.${h}`)) ?? null;
  } catch {
    return null;
  }
}

/**
 * What a click or Enter outside a negotiation would act on, as the label confirm_intent must approve,
 * when it could send a message on a marketplace: a text box there holds text. Null when it can't: off
 * the marketplaces, a click into a text box or on a link, searching, filtering or opening a menu, or
 * nothing typed. desktop-agent leaves the site's search box out of what the boxes hold.
 */
export function marketplaceSend(
  kind: "click" | "enter",
  el: AgentElement | null,
  tabUrl: string | null,
): string | null {
  const site = marketplaceOf(el?.url ?? tabUrl);
  if (!site || !el) return null;
  if (kind === "click" && (el.editable || el.tag === "a")) return null;
  if (el.search || el.toggle || (kind === "click" && narrowingLabel(el.label))) return null;
  // An older desktop-agent can't say what the boxes hold: as if they held something.
  if (el.fields && !el.fields.some((f) => f.trim())) return null;
  const what = kind === "enter" ? "Enter" : el.label.trim() || el.tag;
  return `${what}, with text in a box on ${site}`;
}
