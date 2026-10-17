// Scripts the browser toolset runs inside a page, in Hatbot's own isolated world: the page shares the DOM with
// them but can't see or rewrite their globals, so it can't remap an element reference.
//
// Each is a function expression; browser.ts calls it with one JSON argument.

/** Shared by the scripts below: element references, roles, names and visibility. */
/**
 * The text boxes a click or Enter could send, for the brain's exact-text check (PLAN.md §16.3): what each
 * visible one holds, whitespace collapsed, in the element's form when that has any, otherwise in its page,
 * open shadow roots and same-origin frames included. A box inside another (an editable region in a
 * role=textbox) counts once. A site's search box isn't one: its query stays in it on every page.
 */
export const FIELDS = `
  const TEXT_BOX = 'textarea, input:not([type]), input[type=text], input[type=search], input[type=email], input[type=tel], input[type=url], input[type=number], [contenteditable=""], [contenteditable=true], [contenteditable=plaintext-only], [role=textbox]';
  const isTextBox = (e) => !!e && e.nodeType === 1 && (e.matches(TEXT_BOX) || e.isContentEditable);
  const shownBox = (e) => e.getClientRects().length > 0
    && (e.ownerDocument.defaultView || window).getComputedStyle(e).visibility !== 'hidden';
  // A search box says so in its type or role, its search landmark, a search (GET) form, or its own name.
  const SEARCH_HINT = /search|szuka|wyszuk|hleda|vyhled|suche|recherche/i;
  const isSearchBox = (e) => e.matches('input[type=search], [role=searchbox]') || !!e.closest('[role=search]')
    || ((e.form?.getAttribute('method') || '').toLowerCase() === 'get')
    || (e.matches('input:not([type]), input[type=text]') && (e.getAttribute('name') === 'q'
      || SEARCH_HINT.test([e.getAttribute('placeholder'), e.getAttribute('aria-label'), e.getAttribute('name'),
        e.id, e.getAttribute('title')].join(' '))));
  const boxValue = (e) => String((e.matches('input, textarea') ? e.value : e.innerText) || '')
    .replace(/\\s+/g, ' ').trim().slice(0, 4000);
  const boxesIn = (root, out = []) => {
    for (const e of root.querySelectorAll('*')) {
      if (e.matches(TEXT_BOX)) out.push(e);
      if (e.shadowRoot) boxesIn(e.shadowRoot, out);
      if (e.tagName === 'IFRAME' || e.tagName === 'FRAME') {
        let d = null;
        try { d = e.contentDocument; } catch {}
        if (d) boxesIn(d, out);
      }
    }
    return out;
  };
  const fieldsFor = (el) => {
    const all = (root) => boxesIn(root).filter((b) => shownBox(b) && !isSearchBox(b));
    const form = el.closest('form');
    const inForm = form ? all(form) : [];
    const boxes = inForm.length ? inForm : all(el.ownerDocument);
    return boxes.filter((b) => !boxes.some((o) => o !== b && o.contains(b))).map(boxValue).filter(Boolean);
  };
`;

/**
 * What the brain's click and Enter checks look at (PLAN.md §6.1), shared by the browser toolset's inspect
 * and the screen's (cdp.ts): `elementInfo(el)` for the control at or around `el`.
 */
export const ELEMENT = `
  ${FIELDS}
  const CONTROL = 'button, a, input, select, textarea, label, summary, [role=button], [role=link], [role=menuitem], [onclick]';
  const squash = (s) => String(s || '').trim().replace(/\\s+/g, ' ').slice(0, 200);
  // Its name as a person would read it: aria-labelledby, aria-label, an input's value, its text, its title,
  // or failing those its icon's (img alt, svg aria-label or title).
  const nameFor = (e) => {
    const by = (e.getAttribute('aria-labelledby') || '').split(/\\s+/).filter(Boolean)
      .map((id) => e.ownerDocument.getElementById(id)?.textContent || '').join(' ');
    const own = squash(by) || squash(e.getAttribute('aria-label')) || (e.tagName === 'INPUT' ? squash(e.value) : '')
      || squash(e.innerText) || squash(e.getAttribute('title')) || squash(e.getAttribute('alt'));
    if (own) return own;
    const icon = e.querySelector('img[alt], [aria-label], [title], svg title');
    if (!icon) return '';
    return squash(icon.tagName.toLowerCase() === 'title' ? icon.textContent
      : icon.getAttribute('alt') || icon.getAttribute('aria-label') || icon.getAttribute('title'));
  };
  const TOGGLE_ROLES = ['tab', 'switch', 'checkbox', 'radio', 'option', 'menuitemcheckbox', 'menuitemradio', 'combobox'];
  const isToggle = (e) => e.hasAttribute('aria-expanded') || e.hasAttribute('aria-pressed')
    || (e.getAttribute('aria-haspopup') || 'false') !== 'false' || e.tagName === 'SUMMARY' || e.tagName === 'SELECT'
    || TOGGLE_ROLES.includes(e.getAttribute('role'))
    || (e.tagName === 'INPUT' && ['checkbox', 'radio'].includes(e.type))
    || (e.tagName === 'LABEL' && !!e.control && e.control !== e && isToggle(e.control));
  // The visible text boxes in the nearest part of the page around a control that has any.
  const boxesNear = (e) => {
    for (let up = e.parentElement, i = 0; up && up !== e.ownerDocument.body && i < 4; up = up.parentElement, i++) {
      const boxes = boxesIn(up).filter(shownBox);
      if (boxes.length) return boxes;
    }
    return [];
  };
  // A search box, or a control in a search or filter form, or beside search boxes and no other box (the
  // magnifier by a site's search box): Enter or a click there narrows a list. In any other form, Enter or
  // a button submits all of it, whatever box it's in: a page built as one form has its search box in it.
  const isSearch = (e, form) => {
    if (e.closest('[role=search]')) return true;
    if (form) return (form.getAttribute('method') || '').toLowerCase() === 'get';
    if (e.matches('[role=combobox]')) return true;
    if (isTextBox(e)) return isSearchBox(e);
    const boxes = boxesNear(e);
    return boxes.length > 0 && boxes.every(isSearchBox);
  };
  const BUTTON = 'button, [role=button], input[type=submit], input[type=button], input[type=image]';
  // The buttons by a text box: a chat box's Send, which Enter in the box may press. The ones after it in
  // the nearest part of the page around it that has any, however far up; then, laid out in reverse, the
  // ones before it in the nearest part below the page itself that has any. Up through open shadow roots.
  const buttonsAfter = (el) => {
    const body = el.ownerDocument.body;
    const before = [];
    let up = el.parentNode;
    while (up && up.nodeType !== 9) {
      const near = [...up.querySelectorAll(BUTTON)].filter((b) => !el.contains(b) && shownBox(b));
      const after = near.filter((b) => el.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
      if (!before.length && up !== body) before.push(...near.filter((b) => !after.includes(b)).reverse());
      if (after.length) return [...after.slice(0, 5), ...before.slice(0, 3)].map(nameFor);
      if (up === body) break;
      up = up.nodeType === 11 ? up.host : up.parentNode;
    }
    return before.slice(0, 3).map(nameFor);
  };
  // A div or icon a page made clickable with a handler, no role: the outermost part around it with a
  // pointer cursor or a tab stop, unless that's most of the page.
  const clickableAround = (el) => {
    const doc = el.ownerDocument, view = doc.defaultView || window;
    let found = null;
    for (let e = el; e && e.nodeType === 1 && e !== doc.body && e !== doc.documentElement; e = e.parentElement) {
      const tab = e.getAttribute('tabindex');
      if (view.getComputedStyle(e).cursor !== 'pointer' && !(tab !== null && Number(tab) >= 0)) continue;
      const r = e.getBoundingClientRect();
      if (r.width * r.height > 0.4 * view.innerWidth * view.innerHeight) break;
      found = e;
    }
    return found;
  };
  const elementInfo = (el) => {
    if (!el || el === el.ownerDocument.body) return null;
    const c = el.closest(CONTROL);
    let clickable = false;
    if (c) el = c;
    else if (!isTextBox(el)) {
      const k = clickableAround(el);
      if (k) { el = k; clickable = true; }
    }
    const form = el.closest('form');
    const editable = isTextBox(el);
    const out = { tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || (clickable ? 'clickable' : null), type: el.getAttribute('type'),
      label: el.tagName === 'INPUT' && !['submit', 'button', 'image', 'reset'].includes(el.type) ? (el.placeholder || el.name || '') : nameFor(el),
      inForm: !!form, url: location.href, editable, fields: fieldsFor(el),
      toggle: isToggle(el), search: isSearch(el, form) };
    if (form) {
      const submit = form.querySelector('button[type=submit], input[type=submit], button:not([type])');
      if (submit) out.submitLabel = nameFor(submit);
    }
    if (editable) out.buttonsAfter = buttonsAfter(el);
    const link = el.closest('a[href], area[href]');
    if (link) {
      try { out.href = new URL(link.getAttribute('href'), link.baseURI).href.slice(0, 2000); } catch {}
    }
    return out;
  };
  const isFrame = (e) => !!e && (e.tagName === 'IFRAME' || e.tagName === 'FRAME');
  // The deepest element at a viewport point, through open shadow roots and same-origin frames. At a frame it
  // can't enter (another origin's), { el: the frame, frame: the point inside it }, for browser.ts to follow.
  const elementAt = (x, y) => {
    let doc = document, ox = 0, oy = 0, el = null;
    for (;;) {
      let hit = doc.elementFromPoint(x - ox, y - oy);
      while (hit && hit.shadowRoot) {
        const deeper = hit.shadowRoot.elementFromPoint(x - ox, y - oy);
        if (!deeper || deeper === hit) break;
        hit = deeper;
      }
      if (!hit) return { el };
      el = hit;
      if (!isFrame(hit)) return { el };
      const r = hit.getBoundingClientRect();
      const fx = ox + r.left + hit.clientLeft, fy = oy + r.top + hit.clientTop;
      let inner = null;
      try { inner = hit.contentDocument; } catch {}
      if (!inner) return { el, frame: { x: x - fx, y: y - fy } };
      ox = fx; oy = fy; doc = inner;
    }
  };
  // The focused element, through open shadow roots and same-origin frames; at a frame it can't enter, that
  // frame with { focused: true }.
  const focusedAt = () => {
    let el = document.activeElement;
    for (;;) {
      while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
      if (!isFrame(el)) return { el };
      let inner = null;
      try { inner = el.contentDocument; } catch {}
      if (!inner) return { el, frame: { focused: true } };
      el = inner.activeElement;
    }
  };
  // A frame left for browser.ts to follow: it finds the element through this.
  const leaveFrame = (out, at) => {
    if (out && at.frame && isFrame(at.el)) { globalThis.__hatbotFrame = at.el; out.frame = at.frame; }
    return out;
  };
`;

const COMMON = `
  const H = (globalThis.__hatbot ||= { byRef: new Map(), byEl: new WeakMap() });
  const refOf = (el, o) => {
    let r = H.byEl.get(el);
    if (!r) { r = 'ref_' + o.next++; H.byEl.set(el, r); H.byRef.set(r, new WeakRef(el)); }
    return r;
  };
  const byRef = (ref) => {
    const el = H.byRef.get(ref)?.deref();
    return el && el.isConnected ? el : null;
  };
  const clean = (s, n) => {
    s = String(s || '').replace(/\\s+/g, ' ').trim();
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  };
  const INPUT_ROLES = { button: 'button', submit: 'button', reset: 'button', image: 'button', checkbox: 'checkbox',
    radio: 'radio', range: 'slider', number: 'spinbutton', search: 'searchbox', file: 'button', color: 'button' };
  const TAG_ROLES = { BUTTON: 'button', TEXTAREA: 'textbox', OPTION: 'option', NAV: 'navigation', MAIN: 'main',
    ASIDE: 'complementary', FORM: 'form', DIALOG: 'dialog', TABLE: 'table', TR: 'row', TD: 'cell', TH: 'columnheader',
    UL: 'list', OL: 'list', LI: 'listitem', SUMMARY: 'button', DETAILS: 'group', FIELDSET: 'group', IFRAME: 'iframe',
    H1: 'heading', H2: 'heading', H3: 'heading', H4: 'heading', H5: 'heading', H6: 'heading' };
  const INTERACTIVE = new Set(['link', 'button', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'listbox',
    'option', 'slider', 'spinbutton', 'switch', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'treeitem',
    'clickable']);
  // Roles whose name is their text, so their text isn't listed again underneath.
  const NAMED_BY_TEXT = new Set(['link', 'button', 'heading', 'option', 'tab', 'menuitem', 'menuitemcheckbox',
    'menuitemradio', 'treeitem', 'cell', 'columnheader', 'clickable', 'switch']);
  const roleOf = (el) => {
    const explicit = (el.getAttribute('role') || '').trim().split(/\\s+/)[0];
    if (explicit && explicit !== 'presentation' && explicit !== 'none' && explicit !== 'generic') return explicit;
    const tag = el.tagName;
    if ((tag === 'A' || tag === 'AREA') && el.hasAttribute('href')) return 'link';
    if (tag === 'INPUT') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      if (t === 'hidden') return null;
      return INPUT_ROLES[t] || 'textbox';
    }
    if (tag === 'SELECT') return el.multiple || el.size > 1 ? 'listbox' : 'combobox';
    if (tag === 'IMG') return el.getAttribute('alt') ? 'img' : null;
    if (tag === 'svg') return el.getAttribute('aria-label') ? 'img' : null;
    if (el.isContentEditable && !el.parentElement?.isContentEditable) return 'textbox';
    if (TAG_ROLES[tag]) return TAG_ROLES[tag];
    return null;
  };
  const visible = (el) => {
    if (el.getAttribute('aria-hidden') === 'true' || el.hidden) return false;
    if (el.checkVisibility && !el.checkVisibility({ checkVisibilityCSS: true })) return false;
    return true;
  };
  const textOf = (el) => clean(el.innerText ?? el.textContent, 120);
  const nameOf = (el, role) => {
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const t = by.split(/\\s+/).map((id) => el.ownerDocument.getElementById(id)?.textContent || '').join(' ');
      if (t.trim()) return clean(t, 120);
    }
    const aria = el.getAttribute('aria-label');
    if (aria && aria.trim()) return clean(aria, 120);
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      const label = el.labels && el.labels[0];
      if (label) {
        // The label's own words, not the text of the control inside it (a select's options, say).
        let t = '';
        const w = el.ownerDocument.createTreeWalker(label, NodeFilter.SHOW_TEXT);
        for (let n = w.nextNode(); n; n = w.nextNode()) if (!el.contains(n)) t += n.textContent + ' ';
        if (t.trim()) return clean(t, 120);
      }
      if (tag === 'INPUT' && ['button', 'submit', 'reset'].includes(el.type)) return clean(el.value, 120);
      return clean(el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name'), 120);
    }
    if (tag === 'IMG' || (tag === 'INPUT' && el.type === 'image')) return clean(el.getAttribute('alt'), 120);
    if (NAMED_BY_TEXT.has(role)) {
      const t = textOf(el);
      if (t) return t;
      const img = el.querySelector('img[alt], svg[aria-label]');
      if (img) return clean(img.getAttribute('alt') || img.getAttribute('aria-label'), 120);
    }
    return clean(el.getAttribute('title'), 120);
  };
  const extrasOf = (el, role) => {
    const out = [];
    const tag = el.tagName;
    if (role === 'heading') { const m = /^H(\\d)$/.exec(tag); out.push('level=' + (m ? m[1] : el.getAttribute('aria-level') || '2')); }
    if (role === 'link') {
      const href = el.getAttribute('href') || '';
      if (href && !href.startsWith('javascript:')) out.push('href="' + clean(href, 100) + '"');
    }
    if (tag === 'INPUT' || tag === 'TEXTAREA') {
      if (el.type === 'checkbox' || el.type === 'radio') out.push(el.checked ? 'checked' : 'unchecked');
      else if (el.type === 'password') { if (el.value) out.push('value=(hidden)'); }
      else if (!['button', 'submit', 'reset', 'image', 'file'].includes(el.type)) {
        if (el.value) out.push('value="' + clean(el.value, 100) + '"');
        const ph = el.getAttribute('placeholder');
        if (ph && clean(ph, 120) !== nameOf(el, role)) out.push('placeholder="' + clean(ph, 60) + '"');
      }
      if (el.type === 'file') out.push('file input');
      if (el.type === 'password') out.push('password');
    }
    if (tag === 'SELECT') {
      const sel = [...el.selectedOptions].map((o) => clean(o.text, 60));
      if (sel.length) out.push('value="' + sel.join(', ') + '"');
    }
    const checked = el.getAttribute('aria-checked');
    if (checked && tag !== 'INPUT') out.push(checked === 'true' ? 'checked' : 'unchecked');
    const pressed = el.getAttribute('aria-pressed');
    if (pressed === 'true') out.push('pressed');
    const expanded = el.getAttribute('aria-expanded');
    if (expanded) out.push(expanded === 'true' ? 'expanded' : 'collapsed');
    if (el.getAttribute('aria-selected') === 'true' || (tag === 'OPTION' && el.selected)) out.push('selected');
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') out.push('disabled');
    if (el.required) out.push('required');
    return out;
  };
  // Elements a page made clickable with a handler rather than a role: the outermost with a pointer cursor.
  const clickable = (el) => {
    if (el.hasAttribute('onclick')) return true;
    const ti = el.getAttribute('tabindex');
    if (ti !== null && Number(ti) >= 0) return true;
    const view = el.ownerDocument.defaultView;
    if (view.getComputedStyle(el).cursor !== 'pointer') return false;
    const parent = el.parentElement;
    return !parent || view.getComputedStyle(parent).cursor !== 'pointer';
  };
  // The offset of an element's frame from the top-level viewport (same-origin iframes only).
  const frameOffset = (el) => {
    let x = 0, y = 0, win = el.ownerDocument.defaultView;
    while (win && win.frameElement) {
      const r = win.frameElement.getBoundingClientRect();
      x += r.left + win.frameElement.clientLeft; y += r.top + win.frameElement.clientTop;
      win = win.parent;
    }
    return { x, y };
  };
  const rectOf = (el) => {
    const r = el.getBoundingClientRect();
    const o = frameOffset(el);
    return { left: r.left + o.x, top: r.top + o.y, right: r.right + o.x, bottom: r.bottom + o.y, width: r.width, height: r.height };
  };
  const inViewport = (r) => r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 &&
    r.top < innerHeight && r.left < innerWidth;
  // Children, through open shadow roots and into same-origin iframes.
  const childrenOf = (el) => {
    if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
      try { const d = el.contentDocument; return d && d.body ? [d.body] : []; } catch { return []; }
    }
    if (el.tagName === 'SLOT') return el.assignedElements();
    return el.shadowRoot ? [...el.shadowRoot.children] : [...el.children];
  };
  ${ELEMENT}
`;

/**
 * read_page and find. `o`: { next, filter: "interactive" | "all" | undefined, depth, ref, find?: true }.
 * Returns { lines, next } or { error }. With `find`, lines are every listed element, unindented, for scoring.
 */
export const READ_PAGE = `(o) => {
  ${COMMON}
  const all = o.filter === 'all' || o.find;
  const interactiveOnly = o.filter === 'interactive';
  const maxDepth = Math.max(1, o.depth || 15);
  const lines = [];
  let chars = 0, truncated = false;
  const push = (depth, s) => {
    if (truncated) return;
    const line = (o.find || interactiveOnly ? '' : '  '.repeat(depth)) + s;
    if (chars + line.length > o.maxChars) { truncated = true; return; }
    chars += line.length + 1; lines.push(line);
  };
  const walk = (el, depth) => {
    if (truncated || !visible(el)) return;
    const tag = el.tagName;
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE' || tag === 'HEAD') return;
    let role = roleOf(el);
    if (!role && clickable(el)) role = 'clickable';
    const r = rectOf(el);
    const shown = all || inViewport(r) || (r.width === 0 && r.height === 0);
    let listed = false;
    if (role && shown && (!interactiveOnly || INTERACTIVE.has(role))) {
      const name = nameOf(el, role);
      const isContainer = !INTERACTIVE.has(role) && role !== 'heading' && role !== 'img';
      // Unnamed containers add depth without telling the model anything; only list the meaningful ones.
      if (!isContainer || name || ['navigation', 'main', 'form', 'dialog', 'table', 'list', 'row', 'iframe'].includes(role)) {
        if (r.width > 0 || r.height > 0 || role === 'iframe') {
          const extras = extrasOf(el, role);
          push(depth, '- ' + role + (name ? ' "' + name.replace(/"/g, '\\\\"') + '"' : '') + ' [' + refOf(el, o) + ']' +
            (extras.length ? ' ' + extras.join(' ') : ''));
          listed = true;
        }
      }
      if (listed && (role === 'textbox' || role === 'searchbox' || role === 'combobox' || role === 'listbox')) return;
      // Its text is its name; look inside only for controls (a table cell with a link, say).
      if (listed && NAMED_BY_TEXT.has(role) && !hasControls(el)) return;
    }
    const d = listed ? depth + 1 : depth;
    if (d >= maxDepth) return;
    // Text the page shows outside any named element, so a read covers the visible content.
    // A label's words are already the name of its control.
    if (!interactiveOnly && !o.find && shown && !listed && !(tag === 'LABEL' && el.control)) {
      const t = el.innerText ?? '';
      if (t.length <= 300 && !hasControls(el)) {
        const s = clean(t, 300);
        if (s.length > 1) push(d, '- text "' + s.replace(/"/g, '\\\\"') + '"');
        return;
      }
      let own = '';
      for (const n of el.childNodes) if (n.nodeType === 3) own += n.textContent;
      own = clean(own, 300);
      if (own.length > 1) push(d, '- text "' + own.replace(/"/g, '\\\\"') + '"');
    }
    for (const c of childrenOf(el)) walk(c, d);
  };
  const hasControls = (el) => !!el.shadowRoot ||
    !!el.querySelector('a[href], button, input, select, textarea, iframe, [role], [onclick], [tabindex], [contenteditable]');
  let root = document.body || document.documentElement;
  if (o.ref) {
    root = byRef(o.ref);
    if (!root) return { error: o.ref + ' is stale or not found on the current page. Re-read the page to get fresh references.' };
  }
  if (root) walk(root, 0);
  return { lines, next: o.next, truncated };
}`;

/** The viewport centre of a referenced element, scrolled into view first: { x, y } or { error }. */
export const RESOLVE_REF = `(o) => {
  ${COMMON}
  const el = byRef(o.ref);
  if (!el) return { error: o.ref + ' is stale or not found on the current page. Re-read the page to get fresh references.' };
  let r = rectOf(el);
  if (!(r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth)) {
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    r = rectOf(el);
  }
  if (r.width === 0 && r.height === 0) return { error: o.ref + ' has no size on the page (it may be hidden).' };
  const x = Math.round(Math.min(Math.max(r.left + r.width / 2, 0), innerWidth - 1));
  const y = Math.round(Math.min(Math.max(r.top + r.height / 2, 0), innerHeight - 1));
  return { x, y };
}`;

/** scroll_to: { ok } or { error }. */
export const SCROLL_TO = `(o) => {
  ${COMMON}
  const el = byRef(o.ref);
  if (!el) return { error: o.ref + ' is stale or not found on the current page. Re-read the page to get fresh references.' };
  el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
  return { ok: true };
}`;

/**
 * form_input: sets a field's value the way typing would leave it, then fires input and change so the page's own
 * handlers (React and the like) see it. { text } or { error }.
 */
export const FORM_INPUT = `(o) => {
  ${COMMON}
  const el = byRef(o.ref);
  if (!el) return { error: o.ref + ' is stale or not found on the current page. Re-read the page to get fresh references.' };
  const fire = () => {
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const v = o.value;
  if (el.disabled) return { error: o.ref + ' is disabled.' };
  if (el.tagName === 'SELECT') {
    const want = String(v).trim().toLowerCase();
    const opt = [...el.options].find((p) => p.value.toLowerCase() === want) ||
      [...el.options].find((p) => p.text.trim().toLowerCase() === want) ||
      [...el.options].find((p) => p.text.trim().toLowerCase().includes(want));
    if (!opt) return { error: 'No option "' + v + '" in ' + o.ref + '. Options: ' + [...el.options].map((p) => clean(p.text, 40)).slice(0, 30).join(' | ') };
    el.value = opt.value; fire();
    return { text: 'Selected "' + clean(opt.text, 80) + '".' };
  }
  if (el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) {
    const want = typeof v === 'boolean' ? v : String(v).toLowerCase() === 'true';
    if (el.checked !== want) el.click();
    return { text: (el.checked ? 'Checked' : 'Unchecked') + ' ' + o.ref + '.' };
  }
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
    if (el.type === 'file') return { error: o.ref + ' is a file input; uploads aren\\'t enabled.' };
    el.focus();
    const proto = el.tagName === 'INPUT' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, String(v));
    fire();
    return { text: 'Set ' + o.ref + ' to "' + clean(String(v), 80) + '".' };
  }
  if (el.isContentEditable) {
    el.focus(); el.textContent = String(v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return { text: 'Set ' + o.ref + ' to "' + clean(String(v), 80) + '".' };
  }
  return { error: o.ref + ' is a <' + el.tagName.toLowerCase() + '>, not a form field.' };
}`;

/** get_page_text: the main content's visible text. */
export const PAGE_TEXT = `(o) => {
  const main = document.querySelector('main, [role=main], article');
  const body = document.body;
  if (!body) return '';
  let text = (main && main.innerText.trim().length > 200 ? main : body).innerText;
  text = text.replace(/[ \\t]+\\n/g, '\\n').replace(/\\n{3,}/g, '\\n\\n').trim();
  return text.length > o.maxChars ? text.slice(0, o.maxChars) + '\\n[Cut at ' + o.maxChars + ' characters.]' : text;
}`;

/** The element for the click policy: by ref, at a viewport point, or the focused one. */
export const INSPECT = `(o) => {
  ${COMMON}
  // Nothing there, or nothing focused, is the page itself; null means it couldn't be looked at (a stale ref).
  const info = (at) => leaveFrame(elementInfo(at.el) || { tag: 'body', role: null, type: null, label: '',
    inForm: false, url: location.href, editable: false, fields: fieldsFor(document.body) }, at);
  if (o.ref) {
    const el = byRef(o.ref);
    if (!el) return null;
    // A click on a ref lands in its middle, as RESOLVE_REF works it out, scrolled into view first: what's
    // there is what it presses (for a dialog or a card, the button in its middle; for a frame, inside it).
    let r = rectOf(el);
    if (!(r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth)) {
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      r = rectOf(el);
    }
    if (r.width === 0 && r.height === 0) return info({ el });
    const x = Math.round(Math.min(Math.max(r.left + r.width / 2, 0), innerWidth - 1));
    const y = Math.round(Math.min(Math.max(r.top + r.height / 2, 0), innerHeight - 1));
    return info(elementAt(x, y));
  }
  if (typeof o.x === 'number' && typeof o.y === 'number') return info(elementAt(o.x, o.y));
  return info(focusedAt());
}`;

export const VIEWPORT = `() => ({ width: innerWidth, height: innerHeight, scrollX, scrollY, url: location.href, title: document.title })`;
