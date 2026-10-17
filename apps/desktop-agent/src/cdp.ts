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
 * Not a promo code, an email to verify, or the number of a house or of things to buy.
 */
export const SECRET = `
  const SECRET_HINT = /pass(?:word|wd|wort|phrase|code)|\\bpass\\b|has[lł]|\\bpwd?\\b|\\bcc(?: ?(?:num(?:ber)?|no)|\\b)|\\bcard ?(?:num(?:ber)?|no)\\b|(?:credit|debit) ?card|\\b(?:numer|nr) ?kart|\\bcvc|\\bcvv|\\bcsc\\b|\\b(?:otp|pin)(?:code)?\\b|totp|\\b2 ?fa\\b|\\bmfa\\b|\\bkod(?! ?(?:poczt|rabat|promo))|(?<!\\b(?:zip|post(?:al)?|promo(?:tional)?|coupon|discount|rabat) )\\bcode\\b|security ?code|one time|\\btoken|\\bblik|\\bsms|verif(?![a-z]* (?:your |the )?e ?mail)|secret|private ?key|api ?key|recovery(?! ?(?:e ?mail|phone))|mnemonic/;
  const ORDINARY = /\\bzip\\b|post(?:al)? ?code|poczt|house|street|building|apartment|\\bapt\\b|domu|mieszkani|lokal|\\bqty\\b|quantity|ilo[sś][cć]/;
  const CARD_SHAPE = /(?:[0-9x•*] ?){4}(?:[ -]?(?:[0-9x•*]){4}){2,}/i;
  // Inputs nobody types into: a checkbox's value is "on", a button's is its label.
  const UNTYPED = ['hidden', 'checkbox', 'radio', 'submit', 'button', 'reset', 'image', 'file', 'range', 'color'];
  const isSecret = (el) => {
    if (!el || (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') || UNTYPED.includes(el.type)) return false;
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
    if (el.tagName !== 'INPUT' || ORDINARY.test(hints)) return false;
    if (CARD_SHAPE.test(el.getAttribute('placeholder') || '')) return true;
    if (el.maxLength === 1) return true;
    const numeric = el.inputMode === 'numeric' || el.type === 'tel' || /\\\\d|0-9/.test(el.pattern || '');
    // A code; type=number counts things (how many to buy).
    if (numeric && el.type !== 'number' && el.maxLength > 0 && el.maxLength <= 8) return true;
    // A card number, spaces and all; a phone number is shorter, and says it's one.
    return (numeric || el.type === 'number') && el.type !== 'tel' && el.maxLength >= 16
      && el.maxLength <= 23;
  };
`;

// The page's text, and whether a secret field on it holds something now (a screenshot would show a card
// number or a revealed password), each only when asked: a busy page is slow to answer a script. Secret
// fields count in open shadow roots and same-origin frames too. A payment frame from another address
// can't be read, and autofill or a paste may have filled it without typing, so one that's showing counts.
export const CONTEXT_JS = `(o) => {
  ${SECRET}
  // Card fields' frames, by who serves them or what they say they are: whole words, not "karty
  // graficzne" in a video's title.
  const PAY_HOST = /(?:^|\\.)(?:stripe\\.com|stripe\\.network|adyen\\.com|adyenpayments\\.com|braintreegateway\\.com|braintree-api\\.com|payu\\.com|przelewy24\\.pl|tpay\\.com|paynow\\.pl|imoje\\.pl|blik\\.com|checkout\\.com|squareup\\.com|klarna\\.com)$/i;
  const PAY_WORDS = /\\b(?:card ?(?:number|num|no)|credit card|debit card|card payment|cvc|cvv|security code|numer karty|karty płatniczej|karta płatnicza|payment (?:input|frame|field|form|details)|3d ?secure|3ds)\\b/i;
  const shown = (e) => e.getClientRects().length > 0;
  // A frame you could see: not hidden, and big enough on screen to hold a field (Stripe.js leaves an
  // invisible one, a pixel high, on every page that loads it).
  const onScreen = (e) => {
    const view = e.ownerDocument.defaultView || window;
    if (view.getComputedStyle(e).visibility === 'hidden' || e.closest('[aria-hidden=true]')) return false;
    const r = e.getBoundingClientRect();
    return r.width >= 20 && r.height >= 20 && r.right > 0 && r.bottom > 0
      && r.left < view.innerWidth && r.top < view.innerHeight;
  };
  const payFrame = (e) => {
    let host = '';
    try { host = new URL(e.getAttribute('src') || '', e.baseURI).hostname; } catch {}
    return PAY_HOST.test(host) || PAY_WORDS.test(['title', 'name', 'aria-label']
      .map((a) => e.getAttribute(a) || '').join(' '));
  };
  const secretIn = (root) => {
    for (const e of root.querySelectorAll('*')) {
      if ((e.tagName === 'INPUT' || e.tagName === 'TEXTAREA') && e.value && isSecret(e) && shown(e)) return true;
      if (e.shadowRoot && secretIn(e.shadowRoot)) return true;
      if (e.tagName === 'IFRAME' || e.tagName === 'FRAME') {
        let d = null;
        try { d = e.contentDocument; } catch {}
        if (d ? secretIn(d) : onScreen(e) && payFrame(e)) return true;
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
  // does a custom element's whose shadow root is closed: it can't take the focus itself, unless it's the
  // box (contenteditable) or a tab stop, so the focus is on an input inside it that can't be seen.
  const opaque = el.localName.includes('-') && !el.shadowRoot && !el.isContentEditable
    && !el.hasAttribute('tabindex');
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
