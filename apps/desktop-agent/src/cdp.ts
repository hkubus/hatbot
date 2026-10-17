// The tab on screen, for the computer toolset: its URL, title and text, and what's under a click. Through
// browser.ts's one DevTools connection, in Hatbot's isolated world, so the page's own scripts can't see or
// fake the answers.
import type { AgentContext, AgentElement } from "@hatbot/shared/desktop";
import type { Browser } from "./browser";
import { FIELDS } from "./page";

const MAX_TEXT = 20_000;

/**
 * Whether a field takes something Teach mustn't keep: a password, a one-time, SMS or BLIK code, a PIN or
 * card details, going by its type, autocomplete, name, id, placeholder and label (English and Polish), or
 * a short number field, which is mostly a code. Names are split at camelCase, dashes and underscores.
 */
export const SECRET = `
  const SECRET_HINT = /pass|has[lł]|\\bcc\\b|\\bcard ?num|\\bcvc|\\bcvv|\\bcsc\\b|\\botp\\b|totp|\\b2fa\\b|\\bmfa\\b|\\bpin\\b|\\bkod|\\bcode\\b|one time|\\btoken|\\bblik|\\bsms|verif|secret/;
  const isSecret = (el) => {
    if (!el || el.tagName !== 'INPUT' || el.type === 'hidden') return false;
    if (el.type === 'password') return true;
    const hints = [el.getAttribute('autocomplete'), el.getAttribute('name'), el.id,
      el.getAttribute('placeholder'), el.getAttribute('aria-label')].join(' ')
      .replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().replace(/[^a-z0-9ąćęłńóśźż]+/g, ' ');
    if (SECRET_HINT.test(hints)) return true;
    const numeric = el.inputMode === 'numeric' || el.type === 'tel' || el.type === 'number'
      || /\\\\d|0-9/.test(el.pattern || '');
    return numeric && el.maxLength > 0 && el.maxLength <= 8;
  };
`;

// The page's text, and whether a secret field on it holds something now (a screenshot would show a card
// number or a revealed password), each only when asked: a busy page is slow to answer a script.
export const CONTEXT_JS = `(o) => {
  ${SECRET}
  const out = {};
  if (o.text) out.text = (document.body ? document.body.innerText : "").slice(0, o.max);
  if (o.secrets) out.secretShown = [...document.querySelectorAll('input')]
    .some((e) => isSecret(e) && e.value && e.getClientRects().length > 0);
  return out;
}`;

type Page = {
  url: string;
  title: string;
  value: { text?: string; secretShown?: boolean } | undefined;
};

export async function context(
  browser: Browser,
  withText: boolean,
  secrets = false,
): Promise<AgentContext> {
  try {
    const tab: Page | null = await browser
      .onScreen<Page["value"]>(withText || secrets ? CONTEXT_JS : null, {
        max: MAX_TEXT,
        text: withText,
        secrets,
      })
      .catch(async (err) => {
        if (withText || !secrets) throw err;
        // A page that can't be read now (loading, say) may be showing one.
        const bare = await browser.onScreen<undefined>(null);
        return bare && { ...bare, value: { secretShown: true } };
      });
    if (!tab) return { url: null, title: null };
    return {
      url: tab.url,
      title: tab.title,
      ...(withText ? { text: tab.value?.text ?? "" } : {}),
      ...(secrets ? { secretShown: tab.value?.secretShown ?? true } : {}),
    };
  } catch {
    // Chromium isn't running.
    return { url: null, title: null };
  }
}

// Screen point to viewport point: Chromium is maximised with no window border, so the viewport's left edge is
// the window's, and its top is below the tab strip and toolbar (outer height minus inner height).
export const ELEMENT_JS = `(o) => {
  ${FIELDS}
  ${SECRET}
  const dpr = window.devicePixelRatio || 1;
  const left = window.screenX + (window.outerWidth - window.innerWidth * dpr) / 2;
  const top = window.screenY + window.outerHeight - window.innerHeight * dpr;
  let el = o.focused ? document.activeElement
    : document.elementFromPoint((o.x - left) / dpr, (o.y - top) / dpr);
  while (o.focused && el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
  if (!el || el === document.body) return null;
  // Teach mode drops what's typed here. A frame's focus can't be seen from the page, so it counts too.
  const secret = el.tagName === 'IFRAME' || isSecret(el);
  const clickable = el.closest('button, a, input, select, textarea, label, summary, [role=button], [role=link], [role=menuitem], [onclick]');
  if (clickable) el = clickable;
  const text = (e) => (e.getAttribute('aria-label') || e.value || e.innerText || e.title || e.alt || '').trim().replace(/\\s+/g, ' ').slice(0, 200);
  const form = el.closest('form');
  const out = { tag: el.tagName.toLowerCase(), role: el.getAttribute('role'), type: el.getAttribute('type'),
    label: el.tagName === 'INPUT' && !['submit', 'button'].includes(el.type) ? (el.placeholder || el.name || '') : text(el),
    inForm: !!form, secret, url: location.href, editable: isTextBox(el), fields: fieldsFor(el) };
  // Typing goes to the focused element only while the page has the keyboard, not the address bar.
  if (o.focused) out.pageFocus = document.hasFocus();
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
