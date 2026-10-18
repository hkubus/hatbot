// public/sw.js run against a fake browser: its caches, fetch and fetch events.
import { beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ORIGIN = "https://hatbot.test";
const SOURCE = readFileSync(join(import.meta.dir, "../public/sw.js"), "utf8");

type Req = { url: string; method: string; mode: string };
type Handler = (e: unknown) => void;

const keyOf = (r: string | Req) => new URL(typeof r === "string" ? r : r.url, ORIGIN).href;

/** One named cache: responses by URL, oldest first. */
class FakeCache {
  entries = new Map<string, Response>();
  async put(r: string | Req, res: Response) {
    this.entries.set(keyOf(r), res);
  }
  async match(r: string | Req) {
    return this.entries.get(keyOf(r))?.clone();
  }
  async keys() {
    return [...this.entries.keys()].map((url) => ({ url }));
  }
  async delete(r: string | Req) {
    return this.entries.delete(keyOf(r));
  }
  async addAll(urls: string[]) {
    for (const u of urls) this.entries.set(keyOf(u), page(`<p>${u}</p>`));
  }
}

let stores: Map<string, FakeCache>;
let network: (url: string) => Response | Promise<Response>;
let handlers: Record<string, Handler>;

const page = (html: string, status = 200) =>
  new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8" } });
const js = (code: string) =>
  new Response(code, { headers: { "content-type": "text/javascript;charset=utf-8" } });

beforeEach(() => {
  stores = new Map();
  handlers = {};
  network = () => {
    throw new TypeError("Failed to fetch");
  };
  const caches = {
    open: async (name: string) => {
      if (!stores.has(name)) stores.set(name, new FakeCache());
      return stores.get(name);
    },
    match: async (r: string | Req) => {
      for (const c of stores.values()) {
        const hit = await c.match(r);
        if (hit) return hit;
      }
      return undefined;
    },
    keys: async () => [...stores.keys()],
    delete: async (name: string) => stores.delete(name),
  };
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, fn: Handler) => {
      handlers[type] = fn;
    },
    skipWaiting: () => {},
    clients: { claim: async () => {} },
  };
  // A same-origin response is "basic" in a browser, and so is its clone.
  const basic = (res: Response): Response => {
    const clone = res.clone.bind(res);
    Object.defineProperty(res, "type", { value: "basic" });
    Object.defineProperty(res, "clone", { value: () => basic(clone()) });
    return res;
  };
  const fetch = async (r: Req) => basic(await network(r.url));
  new Function("self", "caches", "fetch", SOURCE)(self, caches, fetch);
});

/** Installs the worker, which keeps the offline page. */
async function install() {
  const waits: Promise<unknown>[] = [];
  handlers.install?.({ waitUntil: (p: Promise<unknown>) => waits.push(p) });
  await Promise.all(waits);
}

async function get(path: string, mode = "no-cors") {
  let answer: Promise<Response | undefined> | undefined;
  const waits: Promise<unknown>[] = [];
  handlers.fetch?.({
    request: { url: `${ORIGIN}${path}`, method: "GET", mode },
    respondWith: (p: Promise<Response | undefined>) => {
      answer = p;
    },
    waitUntil: (p: Promise<unknown>) => waits.push(p),
  });
  const res = await answer;
  await Promise.all(waits);
  return res;
}

const cached = (path: string) => [...stores.values()].some((c) => c.entries.has(keyOf(path)));

test("a page that fails to load, or a 5xx while the brain restarts, gets the last app shell or the offline page", async () => {
  await install();
  // No shell kept yet.
  network = () => page("<h1>503 Service Unavailable</h1>", 503);
  expect(await (await get("/", "navigate"))?.text()).toBe("<p>/offline.html</p>");
  // Only an HTML page is kept as the shell.
  network = () => js("not a page");
  await get("/", "navigate");
  expect(cached("/")).toBe(false);
  network = () => page("<title>Hatbot</title>");
  await get("/tasks", "navigate");
  expect(cached("/")).toBe(true);

  network = () => page("<h1>502 Bad Gateway</h1>", 502);
  const res = await get("/chat/2", "navigate");
  expect(res?.status).toBe(200);
  expect(await res?.text()).toBe("<title>Hatbot</title>");
  network = () => {
    throw new TypeError("Failed to fetch");
  };
  expect(await (await get("/settings", "navigate"))?.text()).toBe("<title>Hatbot</title>");
});

test("an asset is kept only when it's a script, style or font", async () => {
  await install();
  // An older brain answered a missing chunk with the app's page.
  network = () => page("<title>Hatbot</title>");
  expect(await (await get("/assets/Memory-OLD.js"))?.text()).toBe("<title>Hatbot</title>");
  expect(cached("/assets/Memory-OLD.js")).toBe(false);

  network = () => js("export const Memory = 1;");
  await get("/assets/Memory-NEW.js");
  expect(cached("/assets/Memory-NEW.js")).toBe(true);
});

test("the old cache, which could hold a page kept as a script, goes on activate", async () => {
  const old = new FakeCache();
  await old.put("/assets/Memory-OLD.js", page("<title>Hatbot</title>"));
  stores.set("hatbot-v1", old);
  await install();
  const waits: Promise<unknown>[] = [];
  handlers.activate?.({ waitUntil: (p: Promise<unknown>) => waits.push(p) });
  await Promise.all(waits);
  expect(stores.has("hatbot-v1")).toBe(false);
  expect(stores.size).toBe(1);
});
