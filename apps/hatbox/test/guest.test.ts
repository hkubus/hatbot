import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BoxBuild, BoxFile } from "@hatbot/shared/hatbox";
import { publicAddress } from "../src/egress";
import { Guest, IDLE_MS } from "../src/guest";
import { routes } from "../src/routes";
import { LocalUnits } from "../src/units";

const TOKEN = "t".repeat(32);
const dirs: string[] = [];
const guests: Guest[] = [];
afterAll(async () => {
  for (const g of guests) await g.stopAll();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** An agent on plain processes, its clock in the test's hands; names under .test reach loopback. */
function agent() {
  const state = mkdtempSync(join(tmpdir(), "hatbox-"));
  dirs.push(state);
  const run = join(state, "run");
  const clock = { now: 1_000_000 };
  const guest = new Guest({
    state,
    run,
    units: new LocalUnits(state, run),
    clock: () => clock.now,
    resolve: async (host) => (host.endsWith(".test") ? "127.0.0.1" : publicAddress(host)),
  });
  guests.push(guest);
  const app = routes(guest, { token: TOKEN });
  const send = (path: string, init: RequestInit & { version?: number } = {}) =>
    app(
      new Request(`http://agent${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "x-hatbox-version": String(init.version ?? 1),
          ...(init.headers as Record<string, string>),
        },
      }),
    );
  const put = (id: number, files: BoxFile[], version = 1) =>
    send(`/boxes/${id}`, { method: "PUT", version, body: JSON.stringify({ files }) });
  const build = async (id: number, version = 1) =>
    (await (await send(`/boxes/${id}/build`, { method: "POST", version })).json()) as BoxBuild;
  return { state, guest, clock, send, put, build };
}

const PAGE: BoxFile[] = [
  {
    path: "index.html",
    content:
      '<html><head><link rel="stylesheet" href="./style.css"></head><body><script type="module" src="./app.ts"></script></body></html>',
  },
  { path: "style.css", content: 'body::after { content: "from style.css" }' },
  { path: "app.ts", content: 'document.body.append("made by app.ts");' },
];

test("a server box is built into one page and a backend that starts when asked, stops when idle and is deleted", async () => {
  const a = agent();
  const files = [
    ...PAGE,
    { path: "lib/count.ts", content: "let n = 0;\nexport const next = () => ++n;" },
    {
      path: "server.ts",
      content: `import { next } from "./lib/count";
export default {
  fetch(req: Request) {
    const url = new URL(req.url);
    return Response.json({ n: next(), path: url.pathname, q: url.searchParams.get("q"), auth: req.headers.get("authorization"), sent: req.headers.get("x-sent") });
  },
  scheduled() { console.log("ran on schedule"); return { notify: "Price dropped to €40" }; },
};`,
    },
  ];
  expect((await a.send("/boxes", { headers: { authorization: "Bearer nope" } })).status).toBe(401);
  expect((await a.put(1, files)).status).toBe(204);
  const built = await a.build(1);
  expect(built.ok).toBe(true);
  // One file: the script and the style are in it.
  expect(built.page).toContain("made by app.ts");
  expect(built.page).toContain("from style.css");
  expect(await (await a.send("/boxes")).json()).toEqual([{ id: 1, version: 1 }]);

  const ask = async (path: string) =>
    (await (
      await a.send(`/boxes/1/http${path}`, { headers: { "x-sent": "yes" } })
    ).json()) as Record<string, unknown>;
  // The brain's token isn't passed to the box.
  expect(await ask("/api/count?q=1")).toEqual({
    n: 1,
    path: "/api/count",
    q: "1",
    auth: null,
    sent: "yes",
  });
  expect((await ask("/")).n).toBe(2);
  // A version the guest hasn't built: the brain is told to send it again.
  const stale = await a.send("/boxes/1/http/", { version: 2 });
  expect([stale.status, ((await stale.json()) as { missing?: boolean }).missing]).toEqual([
    409,
    true,
  ]);

  expect(await (await a.send("/boxes/1/scheduled", { method: "POST" })).json()).toEqual({
    ok: true,
    notify: "Price dropped to €40",
  });
  expect(await (await a.send("/boxes/1/logs")).text()).toContain("ran on schedule");

  // Not asked anything for 15 minutes, it's stopped, and starts afresh when asked again.
  a.clock.now += IDLE_MS;
  await a.guest.sweep();
  expect((await ask("/")).n).toBe(1);

  await a.send("/boxes/1", { method: "DELETE" });
  expect(await (await a.send("/boxes")).json()).toEqual([]);
  expect(existsSync(join(a.state, "logs", "1.log"))).toBe(false);
  expect((await a.send("/boxes/1/http/")).status).toBe(409);
}, 60_000);

test("a box's files are plain files inside it: other paths and package files are refused", async () => {
  const a = agent();
  for (const path of [
    "../escape.ts",
    "/etc/cron.d/x.ts",
    "lib/../../escape.ts",
    ".env.ts",
    "package.json",
  ]) {
    const res = await a.put(2, [...PAGE, { path, content: "x" }]);
    expect([path, res.status]).toEqual([path, 400]);
  }
  expect(existsSync(join(a.state, "escape.ts"))).toBe(false);
  expect(existsSync(join(a.state, "build", "2"))).toBe(false);
  expect((await a.put(2, [...PAGE, { path: "lib/a.ts", content: "x" }])).status).toBe(204);
  expect(statSync(join(a.state, "build", "2", "src", "lib", "a.ts")).mode & 0o7777).toBe(0o644);
}, 30_000);

test("a backend reaches only box.json's hosts, through the agent, and never a local address", async () => {
  const site = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/away") return Response.redirect("http://elsewhere.test/", 302);
      return new Response(`hello ${req.headers.get("x-sent")}`, { headers: { "x-back": "yes" } });
    },
  });
  try {
    const a = agent();
    const files = [
      ...PAGE,
      { path: "box.json", content: JSON.stringify({ hosts: ["api.test"] }) },
      {
        path: "server.ts",
        content: `export default {
  async fetch(req: Request) {
    try {
      const r = await fetch(new URL(req.url).searchParams.get("u")!, { headers: { "x-sent": "yes" } });
      return new Response(await r.text(), { headers: { "x-got": r.headers.get("x-back") ?? "" } });
    } catch (err) {
      return new Response((err as Error).message, { status: 502 });
    }
  },
};`,
      },
    ];
    await a.put(3, files);
    expect((await a.build(3)).ok).toBe(true);
    const via = (u: string) => a.send(`/boxes/3/http/?u=${encodeURIComponent(u)}`);

    const ok = await via(`http://api.test:${site.port}/hi`);
    expect([ok.status, await ok.text(), ok.headers.get("x-got")]).toEqual([
      200,
      "hello yes",
      "yes",
    ]);
    const other = await via(`http://other.test:${site.port}/`);
    expect([other.status, await other.text()]).toEqual([
      502,
      "other.test isn't in box.json's hosts.",
    ]);
    const away = await via(`http://api.test:${site.port}/away`);
    expect(await away.text()).toContain("a redirect went there");
    expect(await (await a.send("/boxes/3/logs")).text()).toContain(
      "[hatbox] Not fetched: other.test",
    );
    // A listed host whose name leads to the LAN isn't reached either.
    await expect(publicAddress("api.test", async () => ["10.1.2.3"])).rejects.toThrow(
      "local address",
    );
  } finally {
    site.stop(true);
  }
}, 60_000);
