// Chromium's DevTools protocol on localhost:9222: which tab is showing, its text, and what's under a click.
import type { AgentContext, AgentElement } from "@hatbot/shared/desktop";

const CDP = process.env.HATBOT_CDP ?? "http://127.0.0.1:9222";

type Target = { type: string; url: string; title: string; webSocketDebuggerUrl?: string };

/** Evaluates an expression in a page and returns its value (JSON-serialisable results only). */
async function evaluate<T>(wsUrl: string, expression: string, timeoutMs = 3000): Promise<T> {
  const ws = new WebSocket(wsUrl);
  try {
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("CDP timed out")), timeoutMs);
      ws.onerror = () => reject(new Error("CDP connection failed"));
      ws.onopen = () =>
        ws.send(
          JSON.stringify({
            id: 1,
            method: "Runtime.evaluate",
            params: { expression, returnByValue: true },
          }),
        );
      ws.onmessage = (e) => {
        const msg = JSON.parse(String(e.data));
        if (msg.id !== 1) return;
        clearTimeout(timer);
        if (msg.error || msg.result?.exceptionDetails) reject(new Error("evaluation failed"));
        else resolve(msg.result.result.value as T);
      };
    });
  } finally {
    ws.close();
  }
}

/** The page target that's visible: the active tab of the (single) Chromium window. */
async function visiblePage(): Promise<Target | null> {
  const res = await fetch(`${CDP}/json/list`, { signal: AbortSignal.timeout(2000) });
  const pages = ((await res.json()) as Target[]).filter(
    (t) => t.type === "page" && t.webSocketDebuggerUrl,
  );
  for (const page of pages) {
    try {
      if (
        (await evaluate<string>(
          page.webSocketDebuggerUrl as string,
          "document.visibilityState",
        )) === "visible"
      )
        return page;
    } catch {
      // A page that's loading or crashed; try the next.
    }
  }
  return pages[0] ?? null;
}

const MAX_TEXT = 20_000;

export async function context(withText: boolean): Promise<AgentContext> {
  try {
    const page = await visiblePage();
    if (!page) return { url: null, title: null };
    const out: AgentContext = { url: page.url, title: page.title };
    if (withText && page.webSocketDebuggerUrl) {
      out.text = await evaluate<string>(
        page.webSocketDebuggerUrl,
        `(document.body ? document.body.innerText : "").slice(0, ${MAX_TEXT})`,
      );
    }
    return out;
  } catch {
    // Chromium isn't running.
    return { url: null, title: null };
  }
}

// Screen point to viewport point: Chromium is maximised with no window border, so the viewport's left edge is
// the window's, and its top is below the tab strip and toolbar (outer height minus inner height).
const ELEMENT_JS = (x: number, y: number, focused: boolean) => `(() => {
  const dpr = window.devicePixelRatio || 1;
  const left = window.screenX + (window.outerWidth - window.innerWidth * dpr) / 2;
  const top = window.screenY + window.outerHeight - window.innerHeight * dpr;
  let el = ${focused} ? document.activeElement
    : document.elementFromPoint((${x} - left) / dpr, (${y} - top) / dpr);
  if (!el || el === document.body) return null;
  const clickable = el.closest('button, a, input, select, textarea, label, summary, [role=button], [role=link], [role=menuitem], [onclick]');
  if (clickable) el = clickable;
  const text = (e) => (e.getAttribute('aria-label') || e.value || e.innerText || e.title || e.alt || '').trim().replace(/\\s+/g, ' ').slice(0, 200);
  const form = el.closest('form');
  const out = { tag: el.tagName.toLowerCase(), role: el.getAttribute('role'), type: el.getAttribute('type'),
    label: el.tagName === 'INPUT' && !['submit', 'button'].includes(el.type) ? (el.placeholder || el.name || '') : text(el),
    inForm: !!form };
  if (${focused} && form) {
    const submit = form.querySelector('button[type=submit], input[type=submit], button:not([type])');
    if (submit) out.submitLabel = text(submit);
  }
  return out;
})()`;

/** The element under a screen point, or the focused element when x and y are omitted. */
export async function inspect(x?: number, y?: number): Promise<AgentElement | null> {
  try {
    const page = await visiblePage();
    if (!page?.webSocketDebuggerUrl) return null;
    const focused = x === undefined || y === undefined;
    return await evaluate<AgentElement | null>(
      page.webSocketDebuggerUrl,
      ELEMENT_JS(Math.round(x ?? 0), Math.round(y ?? 0), focused),
    );
  } catch {
    return null;
  }
}
