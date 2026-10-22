// Messages to sellers go through a negotiation's mandate and exact-text gate. A desktop task that isn't
// one asks first before a click or Enter that could send what's in a text box on a marketplace, whatever
// the button is called; an icon-only Send has no label to catch.
import type { AgentElement } from "@hatbot/shared/desktop";
import { narrowingLabel, onHost } from "../tasks/policy";

export const MARKETPLACE_HOSTS = ["olx.pl", "allegrolokalnie.pl", "vinted.pl"];

export function marketplaceOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return MARKETPLACE_HOSTS.find((h) => onHost(host, h)) ?? null;
  } catch {
    return null;
  }
}

/** The label confirm_intent must approve. desktop-agent leaves the site's search box out of `fields`. */
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
