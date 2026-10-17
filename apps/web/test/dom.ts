// Just enough of a browser for the web app's modules to load and run under bun test. Each test file
// that needs it calls installDom() before importing them; it's taken away after the file, so the
// brain's tests never see a browser.
import { afterAll } from "bun:test";

class MemoryStorage {
  private map = new Map<string, string>();
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

type Frame = (t: number) => void;

export function installDom(extra: Record<string, unknown> = {}) {
  const g = globalThis as Record<string, unknown>;
  const frames = new Map<number, Frame>();
  let frame = 0;
  const document = Object.assign(new EventTarget(), {
    visibilityState: "visible",
    hasFocus: () => true,
  });
  const added: Record<string, unknown> = {
    sessionStorage: new MemoryStorage(),
    localStorage: new MemoryStorage(),
    window: new EventTarget(),
    document,
    location: {
      protocol: "http:",
      host: "hatbot.test",
      origin: "http://hatbot.test",
      pathname: "/",
      search: "",
    },
    requestAnimationFrame: (f: Frame) => {
      frames.set(++frame, f);
      return frame;
    },
    cancelAnimationFrame: (id: number) => frames.delete(id),
    ...extra,
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
    storage: added.sessionStorage as MemoryStorage,
    /** Runs the animation frames asked for so far. */
    flushFrames() {
      const now = [...frames.values()];
      frames.clear();
      for (const f of now) f(0);
    },
  };
}
