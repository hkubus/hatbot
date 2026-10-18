import { afterAll, beforeAll, expect, test } from "bun:test";
import { handle, type RenderOptions } from "../src/render";
import { startChromium, withChromium } from "./chromium";

// The first Chromium that runs here; render.ts starts its own.
let chromium = "";
beforeAll(async () => {
  if (!withChromium) return;
  const started = await startChromium();
  await started.stop();
  chromium = started.path;
});

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    if (new URL(req.url).pathname === "/price.json") return Response.json({ price: "€1,299" });
    // Empty as sent: the price is written by a script, after a fetch and a wait.
    return new Response(
      `<!doctype html><title>Shop</title><p id="price">Loading…</p>
      <script>
        fetch("/price.json").then((r) => r.json()).then((d) => {
          setTimeout(() => { document.getElementById("price").textContent = d.price; }, 3000);
        });
      </script>`,
      { headers: { "content-type": "text/html" } },
    );
  },
});
afterAll(() => server.stop(true));
const call = (body: unknown, opts: RenderOptions) =>
  handle(
    new Request("http://render/render", { method: "POST", body: JSON.stringify(body) }),
    opts,
  ).then(async (r) => ({ status: r.status, body: (await r.json()) as Record<string, unknown> }));

test.skipIf(!withChromium)("a page's scripts run before it's read", async () => {
  // The test server is on loopback, which the real check refuses.
  const r = await call(
    { url: `http://127.0.0.1:${server.port}/shop` },
    { chromium, check: async () => {} },
  );
  expect(r.status).toBe(200);
  expect(r.body.html).toContain('<p id="price">€1,299</p>');
});

test("only the internet is rendered, over http and https", async () => {
  const real = { chromium: "/nonexistent" };
  expect(await call({ url: "file:///etc/passwd" }, real)).toEqual({
    status: 400,
    body: { error: "Only http and https." },
  });
  const local = await call({ url: "http://[::ffff:127.0.0.1]:9222/json/list" }, real);
  expect(local.status).toBe(400);
  expect(local.body.error).toContain("local address");
});
