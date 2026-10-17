// Just enough of a browser for router.ts: window events, location and a history stack. Bun runs every
// test file in one process, so `restore` takes the globals away again afterwards.
type Globals = Record<"window" | "location" | "history" | "PopStateEvent", unknown>;

export function fakeBrowser(start = "/") {
  const g = globalThis as unknown as Globals;
  const keys = ["window", "location", "history", "PopStateEvent"] as const;
  const before = Object.fromEntries(keys.map((k) => [k, g[k]])) as Globals;
  const win = new EventTarget() as EventTarget & {
    confirm?: (text: string) => boolean;
    prompt?: (text: string) => string | null;
  };
  const entries = [start];
  let at = 0;
  const location = {
    get pathname() {
      return new URL(entries[at] as string, "http://hatbot.test").pathname;
    },
    get search() {
      return new URL(entries[at] as string, "http://hatbot.test").search;
    },
    origin: "http://hatbot.test",
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
      setTimeout(() => win.dispatchEvent(new Event("popstate")), 0);
    },
    back() {
      history.go(-1);
    },
    forward() {
      history.go(1);
    },
  };
  g.window = win;
  g.location = location;
  g.history = history;
  g.PopStateEvent = Event;
  return {
    window: win,
    history,
    /** The address bar, and the history around it. */
    url: () => location.pathname + location.search,
    entries: () => entries.slice(),
    restore() {
      for (const k of keys) {
        if (before[k] === undefined) delete g[k];
        else g[k] = before[k];
      }
    },
  };
}

/** Lets pending promises and timers run. */
export const settle = () => new Promise((r) => setTimeout(r, 5));
