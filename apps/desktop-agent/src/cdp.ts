// The tab on screen, for the computer toolset: its URL, title and text, and what's under a click. Through
// browser.ts's one DevTools connection, in Hatbot's isolated world, so the page's own scripts can't see or
// fake the answers.
import type { AgentContext, AgentElement } from "@hatbot/shared/desktop";
import type { Browser } from "./browser";

const MAX_TEXT = 20_000;
const TEXT_JS = `(o) => (document.body ? document.body.innerText : "").slice(0, o.max)`;

export async function context(browser: Browser, withText: boolean): Promise<AgentContext> {
  try {
    const tab = await browser.onScreen<string>(withText ? TEXT_JS : null, { max: MAX_TEXT });
    if (!tab) return { url: null, title: null };
    return { url: tab.url, title: tab.title, ...(withText ? { text: tab.value ?? "" } : {}) };
  } catch {
    // Chromium isn't running.
    return { url: null, title: null };
  }
}

// Screen point to viewport point: Chromium is maximised with no window border, so the viewport's left edge is
// the window's, and its top is below the tab strip and toolbar (outer height minus inner height).
const ELEMENT_JS = `(o) => {
  const dpr = window.devicePixelRatio || 1;
  const left = window.screenX + (window.outerWidth - window.innerWidth * dpr) / 2;
  const top = window.screenY + window.outerHeight - window.innerHeight * dpr;
  let el = o.focused ? document.activeElement
    : document.elementFromPoint((o.x - left) / dpr, (o.y - top) / dpr);
  while (o.focused && el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
  if (!el || el === document.body) return null;
  // Teach mode drops what's typed here. A frame's focus can't be seen from the page, so it counts too.
  const hints = [el.getAttribute('autocomplete'), el.getAttribute('name'), el.id].join(' ');
  const secret = el.tagName === 'IFRAME' || (el.tagName === 'INPUT' && (el.type === 'password'
    || /password|one-time-code|cc-|pass|otp|pin\\b|cvc|cvv|card.?num|secret/i.test(hints)));
  const clickable = el.closest('button, a, input, select, textarea, label, summary, [role=button], [role=link], [role=menuitem], [onclick]');
  if (clickable) el = clickable;
  const text = (e) => (e.getAttribute('aria-label') || e.value || e.innerText || e.title || e.alt || '').trim().replace(/\\s+/g, ' ').slice(0, 200);
  const form = el.closest('form');
  const out = { tag: el.tagName.toLowerCase(), role: el.getAttribute('role'), type: el.getAttribute('type'),
    label: el.tagName === 'INPUT' && !['submit', 'button'].includes(el.type) ? (el.placeholder || el.name || '') : text(el),
    inForm: !!form, secret };
  if (o.focused && form) {
    const submit = form.querySelector('button[type=submit], input[type=submit], button:not([type])');
    if (submit) out.submitLabel = text(submit);
  }
  return out;
}`;

/** The element under a screen point, or the focused element when x and y are omitted. */
export async function inspect(
  browser: Browser,
  x?: number,
  y?: number,
): Promise<AgentElement | null> {
  try {
    const focused = x === undefined || y === undefined;
    const tab = await browser.onScreen<AgentElement | null>(ELEMENT_JS, {
      x: Math.round(x ?? 0),
      y: Math.round(y ?? 0),
      focused,
    });
    return tab?.value ?? null;
  } catch {
    return null;
  }
}
