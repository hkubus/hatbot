// Just enough of a browser for the web app's modules to load and run under bun test. Each test file
// that needs it calls installDom() before importing them; it's taken away after the file, so the
// brain's tests never see a browser.
import { afterAll } from "bun:test";
import { API_PREFIX, type HatbotEvent } from "@hatbot/shared";

/** localStorage or sessionStorage. */
export class MemoryStorage {
  private map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  key(i: number) {
    return [...this.map.keys()][i] ?? null;
  }
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, String(v));
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
  clear() {
    this.map.clear();
  }
}

/** The app's event stream, driven by the test. */
export class FakeSocket {
  static all: FakeSocket[] = [];
  static get last() {
    return FakeSocket.all.at(-1) as FakeSocket;
  }
  onopen: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: unknown) => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  open() {
    this.onopen?.({});
  }
  emit(e: HatbotEvent) {
    this.onmessage?.({ data: JSON.stringify(e) });
  }
  close() {
    this.onclose?.({});
  }
}

export type Request = { method: string; path: string; body: unknown; signal?: AbortSignal };
/** Answers the app's API calls: a value is the JSON answer; throw { status, error } for an error. */
export type Answer = (req: Request) => unknown;

type Frame = (t: number) => void;
const ORIGIN = "http://hatbot.test";

/** A browser at `start`. */
export function installDom(start = "/") {
  const g = globalThis as Record<string, unknown>;
  const frames = new Map<number, Frame>();
  let frame = 0;
  const requests: Request[] = [];
  let answer: Answer = () => ({});
  const win = new EventTarget();
  const entries = [start];
  let at = 0;
  const location = {
    get pathname() {
      return new URL(entries[at] as string, ORIGIN).pathname;
    },
    get search() {
      return new URL(entries[at] as string, ORIGIN).search;
    },
    origin: ORIGIN,
  };
  const history = {
    pushState(_: unknown, __: string, url: string) {
      entries.splice(at + 1, entries.length, url);
      at++;
    },
    replaceState(_: unknown, __: string, url: string) {
      entries[at] = url;
    },
    go(n: number) {
      at = Math.max(0, Math.min(entries.length - 1, at + n));
      // The browser tells the page a little later.
      queueMicrotask(() => win.dispatchEvent(new Event("popstate")));
    },
    back() {
      history.go(-1);
    },
    forward() {
      history.go(1);
    },
  };
  const sessionStorage = new MemoryStorage();
  const added: Record<string, unknown> = {
    sessionStorage,
    localStorage: new MemoryStorage(),
    window: win,
    document: Object.assign(new EventTarget(), {
      visibilityState: "visible",
      hasFocus: () => true,
    }),
    location,
    history,
    PopStateEvent: Event,
    requestAnimationFrame: (f: Frame) => {
      frames.set(++frame, f);
      return frame;
    },
    cancelAnimationFrame: (id: number) => frames.delete(id),
    // A desktop: hover, no touch screen.
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    WebSocket: FakeSocket,
    fetch: async (url: string, init: RequestInit = {}) => {
      const req: Request = {
        method: init.method ?? "GET",
        path: url.replace(API_PREFIX, ""),
        body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
        signal: init.signal ?? undefined,
      };
      requests.push(req);
      try {
        const data = await answer(req);
        return new Response(JSON.stringify(data ?? {}), { status: 200 });
      } catch (err) {
        const e = err as { status?: number; error?: string };
        if (!e.status) throw err;
        return new Response(JSON.stringify({ error: e.error ?? "failed" }), { status: e.status });
      }
    },
  };
  const before = new Map(Object.keys(added).map((k) => [k, Object.getOwnPropertyDescriptor(g, k)]));
  for (const [k, v] of Object.entries(added))
    Object.defineProperty(g, k, { value: v, configurable: true, writable: true });
  afterAll(() => {
    for (const [k, d] of before) {
      if (d) Object.defineProperty(g, k, d);
      else delete g[k];
    }
  });
  return {
    window: win,
    history,
    /** The address bar, and the history around it. */
    url: () => location.pathname + location.search,
    entries: () => entries.slice(),
    storage: sessionStorage,
    /** Every API call made so far. */
    requests,
    /** How API calls are answered from now on. */
    answer(fn: Answer) {
      answer = fn;
    },
    /** Runs the animation frames asked for so far. */
    flushFrames() {
      const now = [...frames.values()];
      frames.clear();
      for (const f of now) f(0);
    },
  };
}

/** Lets pending promises and timers run. */
export const settle = () => new Promise((r) => setTimeout(r, 0));
