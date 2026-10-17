// The tab on screen, for the computer toolset: its URL, title and text, and what's under a click. Through
// browser.ts's one DevTools connection, in Hatbot's isolated world, so the page's own scripts can't see or
// fake the answers.
import type { AgentContext, AgentElement } from "@hatbot/shared/desktop";
import { type Browser, ChromiumDown } from "./browser";
import { ELEMENT } from "./page";

const MAX_TEXT = 20_000;

/**
 * Whether a field takes something Teach mustn't keep: a password, a one-time, SMS or BLIK code, a PIN, card
 * details or a key, going by its type, autocomplete, name, id, placeholder and label (English and Polish),
 * or its shape: one character (a code's box per digit), a short number field (a code), a long one (a card
 * number), or text drawn as dots. Names are split at camelCase, capitals, digits, dashes and underscores,
 * so OTPCode, otp1 and nr_karty read as words. Text areas too: a key or a recovery phrase goes in one.
 */
export const SECRET = `
  const SECRET_HINT = /pass|has[lł]|\\bpwd?\\b|\\bcc(?: ?(?:num|no)|\\b)|\\bcard\\b|\\bcard ?(?:num|no)|credit ?card|\\bkart[aęy]?\\b|\\bpan\\b|\\bcvc|\\bcvv|\\bcsc\\b|\\botp|totp|\\b2 ?fa\\b|\\bmfa\\b|\\bpin|\\bkod|\\bcode\\b|security ?code|one time|\\btoken|\\bblik|\\bsms|verif|secret|private ?key|api ?key|recovery|mnemonic/;
  const CARD_SHAPE = /(?:[0-9x•*] ?){4}(?:[ -]?(?:[0-9x•*]){4}){2,}/i;
  const isSecret = (el) => {
    if (!el || (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') || el.type === 'hidden') return false;
    if (el.type === 'password') return true;
    const hints = [el.getAttribute('autocomplete'), el.getAttribute('name'), el.id,
      el.getAttribute('placeholder'), el.getAttribute('aria-label')].join(' ')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/([A-Za-z])([0-9])/g, '$1 $2').replace(/([0-9])([A-Za-z])/g, '$1 $2')
      .toLowerCase().replace(/[^a-z0-9ąćęłńóśźż]+/g, ' ');
    if (SECRET_HINT.test(hints)) return true;
    try {
      const look = (el.ownerDocument.defaultView || window).getComputedStyle(el);
      if ((look.webkitTextSecurity || 'none') !== 'none') return true;
    } catch {}
    if (el.tagName !== 'INPUT') return false;
    if (CARD_SHAPE.test(el.getAttribute('placeholder') || '')) return true;
    if (el.maxLength === 1 && el.type !== 'checkbox' && el.type !== 'radio') return true;
    const numeric = el.inputMode === 'numeric' || el.type === 'tel' || el.type === 'number'
      || /\\\\d|0-9/.test(el.pattern || '');
    if (numeric && el.maxLength > 0 && el.maxLength <= 8) return true;
    // A card number, spaces and all; a phone number is shorter, and says it's one.
    return numeric && el.type !== 'tel' && el.maxLength >= 16 && el.maxLength <= 23;
  };
`;

// The page's text, and whether a secret field on it holds something now (a screenshot would show a card
// number or a revealed password), each only when asked: a busy page is slow to answer a script. Secret
// fields count in open shadow roots and same-origin frames too. A payment frame from another address
// can't be read, and autofill or a paste may have filled it without typing, so one that's showing counts.
export const CONTEXT_JS = `(o) => {
  ${SECRET}
  const PAY_FRAME = /card|kart[aey]|cvc|cvv|payment|p[lł]atno|stripe|adyen|braintree|payu|przelewy24|blik|3d ?secure|\\b3ds\\b/i;
  const shown = (e) => e.getClientRects().length > 0;
  const secretIn = (root) => {
    for (const e of root.querySelectorAll('*')) {
      if ((e.tagName === 'INPUT' || e.tagName === 'TEXTAREA') && e.value && isSecret(e) && shown(e)) return true;
      if (e.shadowRoot && secretIn(e.shadowRoot)) return true;
      if (e.tagName === 'IFRAME' || e.tagName === 'FRAME') {
        let d = null;
        try { d = e.contentDocument; } catch {}
        if (d ? secretIn(d) : shown(e) && PAY_FRAME.test(['title', 'name', 'id', 'src', 'allow', 'aria-label']
          .map((a) => e.getAttribute(a) || '').join(' '))) return true;
      }
    }
    return false;
  };
  const out = {};
  if (o.text) out.text = (document.body ? document.body.innerText : "").slice(0, o.max);
  if (o.secrets) out.secretShown = secretIn(document);
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
  } catch (err) {
    // Chromium isn't running, so it shows nothing; anything else may be a page showing one.
    return {
      url: null,
      title: null,
      ...(secrets && !(err instanceof ChromiumDown) ? { secretShown: true } : {}),
    };
  }
}

// Screen point to viewport point: Chromium is maximised with no window border, so the viewport's left edge is
// the window's, and its top is below the tab strip and toolbar (outer height minus inner height).
export const ELEMENT_JS = `(o) => {
  ${ELEMENT}
  ${SECRET}
  const dpr = window.devicePixelRatio || 1;
  const left = window.screenX + (window.outerWidth - window.innerWidth * dpr) / 2;
  const top = window.screenY + window.outerHeight - window.innerHeight * dpr;
  const at = o.focused ? focusedAt() : elementAt((o.x - left) / dpr, (o.y - top) / dpr);
  const el = at.el;
  // Nothing focused is the page itself, which still says whether it has the keyboard: when it doesn't,
  // Enter goes to the address bar or another window.
  if ((!el || el === el.ownerDocument.body) && o.focused)
    return { tag: 'body', role: null, type: null, label: '', inForm: false, url: location.href,
      editable: false, fields: fieldsFor(document.body), secret: false, pageFocus: document.hasFocus() };
  if (!el || el === el.ownerDocument.body) return null;
  // Teach mode drops what's typed here. A frame's focus can't be seen from the page, so it counts too, as
  // does a custom element's whose shadow root is closed (or that has none): its input can't be seen.
  const opaque = el.localName.includes('-') && !el.shadowRoot;
  const secret = isFrame(el) || isSecret(el) || opaque;
  const out = { ...elementInfo(el), secret };
  // Typing goes to the focused element only while the page has the keyboard, not the address bar.
  if (o.focused) out.pageFocus = document.hasFocus();
  return leaveFrame(out, at);
}`;

/**
 * The element under a screen point, or the focused element when x and y are omitted, followed into frames.
 * Null when it's not in a page (the browser's own bar, another window) or Chromium isn't running; a page
 * that can't be looked at throws, so the brain doesn't take it for nothing there.
 */
export async function inspect(
  browser: Browser,
  x?: number,
  y?: number,
): Promise<AgentElement | null> {
  try {
    const focused = x === undefined || y === undefined;
    return await browser.screenElement(ELEMENT_JS, {
      x: Math.round(x ?? 0),
      y: Math.round(y ?? 0),
      focused,
    });
  } catch (err) {
    if (err instanceof ChromiumDown) return null;
    throw err;
  }
}
