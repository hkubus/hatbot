import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { handle, loadError, oneAtATime } from "../src/render";

/** A Chromium that runs here: $HATBOT_CHROMIUM, the system's, or Playwright's. CI may have none. */
async function findChromium(): Promise<string | null> {
  const pw = process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(homedir(), ".cache/ms-playwright");
  const candidates = [
    process.env.HATBOT_CHROMIUM,
    ...["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"].map((n) =>
      Bun.which(n),
    ),
    ...(existsSync(pw) ? readdirSync(pw) : [])
      .filter((d) => d.startsWith("chromium-"))
      .sort()
      .reverse()
      .map((d) => join(pw, d, "chrome-linux/chrome")),
  ].filter((p): p is string => Boolean(p && existsSync(p)));
  for (const path of candidates) if (await runs(path)) return path;
  return null;
}

/** Whether it starts and prints a page; a sandbox it can't have here fails it. */
async function runs(path: string): Promise<boolean> {
  const dir = mkdtempSync(join(tmpdir(), "hatbot-render-probe-"));
  try {
    const proc = Bun.spawn(
      [
        path,
        "--headless=new",
        "--dump-dom",
        `--user-data-dir=${dir}`,
        ...(process.getuid?.() === 0 ? ["--no-sandbox"] : []),
        "data:text/html,<p>ok</p>",
      ],
      { stdout: "pipe", stderr: "ignore", timeout: 20_000 },
    );
    return (await new Response(proc.stdout).text()).includes("<p>ok</p>");
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const chromium = await findChromium();
if (!chromium)
  console.log("No Chromium that runs here: the render tests that need one are skipped.");

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const path = new URL(req.url).pathname;
    const html = (body: string) => new Response(body, { headers: { "content-type": "text/html" } });
    if (path === "/price.json") return Response.json({ price: "€1,299" });
    if (path === "/loop") return html("<p>stuck</p><script>for (;;) {}</script>");
    // Empty as sent: the price is written by a script, after a fetch and a wait.
    return html(
      `<!doctype html><title>Shop</title><p id="price">Loading…</p>
      <script>
        fetch("/price.json").then((r) => r.json()).then((d) => {
          setTimeout(() => { document.getElementById("price").textContent = d.price; }, 3000);
        });
      </script>`,
    );
  },
});
afterAll(() => server.stop(true));
const base = `http://127.0.0.1:${server.port}`;
// The test server is on loopback, which the real check refuses.
const opts = { chromium: chromium ?? "", check: async () => {} };
const call = (path: string, body: unknown, o: object = opts) =>
  handle(
    new Request(`http://render${path}`, { method: "POST", body: JSON.stringify(body) }),
    o,
  ).then(async (r) => ({ status: r.status, body: (await r.json()) as Record<string, unknown> }));

test.skipIf(!chromium)("a page's scripts run before it's read", async () => {
  const r = await call("/render", { url: `${base}/shop` });
  expect(r.status).toBe(200);
  expect(r.body.html).toContain('<p id="price">€1,299</p>');
});

test.skipIf(!chromium)("the check renders a page of its own", async () => {
  expect(await call("/check", {})).toEqual({ status: 200, body: { ok: true } });
});

test.skipIf(!chromium)("a page that can't be loaded says why", async () => {
  const closed = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = closed.port;
  closed.stop(true);
  const r = await call("/render", { url: `http://127.0.0.1:${port}/` });
  expect(r).toEqual({
    status: 502,
    body: { error: "Couldn't load it: ERR_CONNECTION_REFUSED." },
  });
});

test.skipIf(!chromium)("a page that never finishes is killed", async () => {
  const started = Date.now();
  const r = await call("/render", { url: `${base}/loop` }, { ...opts, timeoutMs: 3000 });
  expect(r).toEqual({ status: 504, body: { error: "It didn't finish in 3 seconds." } });
  expect(Date.now() - started).toBeLessThan(8000);
});

test("only the internet, over http and https", async () => {
  const real = { chromium: "/nonexistent" };
  expect((await call("/render", { url: "file:///etc/passwd" }, real)).body.error).toBe(
    "Only http and https.",
  );
  for (const url of [
    "http://localhost:9222/json/version",
    "HTTP://LOCALHOST:9222/json/version",
    "http://[::ffff:127.0.0.1]:9222/json/list",
    "http://[::127.0.0.1]:9222/json/list",
    "http://0.0.0.0:9222/json/list",
    "http://2130706433:9222/json/list",
  ]) {
    const local = await call("/render", { url }, real);
    expect(local.status).toBe(400);
    expect([url, local.body.error]).toEqual([url, expect.stringContaining("local address")]);
  }
  expect((await call("/render", {}, real)).status).toBe(400);
});

test("Chromium's error page is told from a page", () => {
  expect(
    loadError(
      '<html><head></head><body class="neterror" jstcache="0"><script>var loadTimeDataRaw = {"errorCode":"ERR_NAME_NOT_RESOLVED"};</script></body></html>',
    ),
  ).toBe("ERR_NAME_NOT_RESOLVED");
  expect(loadError('<body class="shop"><p>neterror</p></body>')).toBeNull();
});

test("one page at a time, and only so many waiting", async () => {
  let running = 0;
  let most = 0;
  const work = async () => {
    most = Math.max(most, ++running);
    await Bun.sleep(20);
    running--;
  };
  const queued = Array.from({ length: 5 }, () => oneAtATime(work));
  await expect(oneAtATime(work)).rejects.toThrow("busy");
  await Promise.all(queued);
  expect(most).toBe(1);
});
