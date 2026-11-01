// A chat page with `n` messages and a stub API, mounted where react-dom can build a tree. It keeps the
// shapes it draws only as nodes: the benchmark counts renders and time, not what a screen shows.
import { installDom } from "../test/dom";
import { thread } from "./thread";

export function chatCase(n: number) {
  const dom = installDom();
  const rows = thread(n);
  dom.answer((req) => {
    if (req.path.includes("/messages")) return rows;
    if (req.path.includes("/conversations"))
      return [
        { id: 1, kind: "direct", title: null, botIds: ["hatbot"], unread: 0, lastMessageAt: null },
      ];
    if (req.path.includes("/teach")) return { recording: null, drafts: [] };
    return [];
  });
  (globalThis as Record<string, unknown>).ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  extendWindow();
  return { ...dom, thread: rows, container: mountPoint() };
}

/** The window react-dom reads when it commits, with the classes it checks for. */
function extendWindow() {
  const real = (globalThis as Record<string, unknown>).window as EventTarget &
    Record<string, unknown>;
  for (const k of ["HTMLIFrameElement", "HTMLInputElement"]) real[k] = class {};
  const win = new Proxy(real, {
    get: (t, k) =>
      k === "getComputedStyle"
        ? () => ({})
        : typeof t[k as string] === "function"
          ? (t[k as string] as (...a: unknown[]) => unknown).bind(t)
          : Reflect.get(t, k),
  });
  Object.defineProperty(globalThis, "window", { get: () => win, configurable: true });
  // Bun's EventTarget methods refuse a proxy as their receiver.
  globalThis.addEventListener = (...a: Parameters<EventTarget["addEventListener"]>) =>
    real.addEventListener(...a);
}

function node(tag: string): Record<string, unknown> {
  const n: Record<string, unknown> = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    nodeName: tag.toUpperCase(),
    namespaceURI: "http://www.w3.org/1999/xhtml",
    style: {},
    childNodes: [] as unknown[],
    ownerDocument: null,
    dataset: {},
    value: "",
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
    classList: { add() {}, remove() {}, contains: () => false },
    addEventListener() {},
    removeEventListener() {},
    setAttribute() {},
    removeAttribute() {},
    getAttribute: () => null,
    hasAttribute: () => false,
    focus() {},
    blur() {},
    scrollTo() {},
    scrollIntoView() {},
    remove() {},
    contains: () => false,
    querySelector: () => null,
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }),
    appendChild(c: unknown) {
      (n.childNodes as unknown[]).push(c);
      return c;
    },
    insertBefore(c: unknown) {
      (n.childNodes as unknown[]).unshift(c);
      return c;
    },
    removeChild(c: unknown) {
      n.childNodes = (n.childNodes as unknown[]).filter((x) => x !== c);
      return c;
    },
  };
  Object.defineProperty(n, "firstChild", { get: () => (n.childNodes as unknown[])[0] ?? null });
  return n;
}

function mountPoint(): Element {
  const container = node("div") as unknown as Element;
  container.ownerDocument = {
    activeElement: null,
    createElement: node,
    createElementNS: (_: string, t: string) => node(t),
    createTextNode: (text: string) => ({ nodeType: 3, nodeValue: text }),
    createComment: (text: string) => ({ nodeType: 8, nodeValue: text }),
    addEventListener() {},
    removeEventListener() {},
    defaultView: null,
  } as unknown as Document;
  return container;
}
