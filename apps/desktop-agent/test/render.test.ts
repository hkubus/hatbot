import { afterAll, beforeAll, expect, test } from "bun:test";
import { MAX_LOOK_HEIGHT } from "@hatbot/shared/desktop";
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
const call = (body: unknown, opts: RenderOptions, path = "/render") =>
  handle(
    new Request(`http://render${path}`, { method: "POST", body: JSON.stringify(body) }),
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

test.skipIf(!withChromium)(
  "a box is drawn with no network: leaving its page and fetching reach nothing, and its errors come back",
  async () => {
    const reached: string[] = [];
    const outside = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        reached.push(new URL(req.url).pathname);
        return new Response("<p>Outside</p>", { headers: { "content-type": "text/html" } });
      },
    });
    try {
      const away = `http://127.0.0.1:${outside.port}`;
      // Taller than the picture shows. It leaves while it's still loading, which no CSP stops.
      const html = `<!doctype html><div style="height:3000px">Habits</div><script>
        fetch("${away}/fetch?data=1");
        location.href = "${away}/leave?data=1";
        throw new Error("boom");
      </script>`;
      // Not the frame's CSP, which refuses the fetch itself: only the renderer is in the way here.
      const look = { html, csp: "sandbox allow-scripts", width: 390, height: 844, dark: true };
      const r = await call(look, { chromium }, "/box");
      expect(r.status).toBe(200);
      expect(reached).toEqual([]);
      // Still the box, not the page it tried to leave for, cut at the most a picture shows.
      expect(r.body.height).toBeGreaterThan(3000);
      const png = Buffer.from(r.body.png as string, "base64");
      expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([390, MAX_LOOK_HEIGHT]);
      expect(r.body.errors).toContainEqual(
        expect.objectContaining({ message: expect.stringContaining("boom"), line: 4 }),
      );
    } finally {
      outside.stop(true);
    }
  },
);

test.skipIf(!withChromium)(
  "a look tries the page: typing is saved, a throwing handler names its step, a failed step ends the run, and fetches go through the relay",
  async () => {
    // Hatbox's preview script, cut down: its store in the page, its fetch through the binding.
    const html = `<!doctype html><input id="name"><button id="add">Add</button><button id="boom">Boom</button>
      <script>
        const kept = new Map();
        const sent = new Map();
        Object.defineProperty(window, "__hatboxAnswer", { value: (id, a) => sent.get(id)(a) });
        window.hatbox = {
          store: { keys: async () => [...kept.keys()], get: async (k) => kept.get(k), set: async (k, v) => void kept.set(k, v) },
          fetch: (path) => new Promise((resolve) => {
            sent.set(sent.size + 1, resolve);
            __hatboxFetch(JSON.stringify({ id: sent.size, path, method: "POST" }));
          }),
        };
        document.getElementById("add").onclick = async () => {
          const name = document.getElementById("name").value;
          const a = await hatbox.fetch("/items?name=" + name);
          await hatbox.store.set("items", [name, a.value.status]);
        };
        document.getElementById("boom").onclick = () => { throw new Error("boom"); };
      </script>`;
    const look = {
      html,
      csp: "sandbox allow-scripts",
      width: 390,
      height: 844,
      dark: false,
      relay: "look-0123456789abcdef",
      steps: [
        { type: "#name", text: "Walk" },
        { click: "#add" },
        { click: "#boom" },
        { eval: "document.querySelector('#name').value" },
        { click: "#missing" },
        { press: "Enter" },
      ],
    };
    const post = (path: string, body: unknown) =>
      handle(new Request(`http://render${path}`, { method: "POST", body: JSON.stringify(body) }), {
        chromium,
      });
    const res = await post("/box", look);
    expect(res.headers.get("content-type")).toBe("application/x-ndjson");
    const fetched: unknown[] = [];
    let last: { result?: Record<string, unknown> } = {};
    const text = new TextDecoder();
    let rest = "";
    for await (const chunk of res.body as ReadableStream<Uint8Array>) {
      const lines = (rest + text.decode(chunk, { stream: true })).split("\n");
      rest = lines.pop() ?? "";
      for (const l of lines) {
        const line = JSON.parse(l);
        if (!line.fetch) last = line;
        else {
          fetched.push(line.fetch);
          const answer = { value: { status: 201, headers: {}, body: "" } };
          await post("/box/answer", { look: look.relay, id: line.fetch.id, answer });
        }
      }
    }
    expect(fetched).toEqual([{ id: 1, path: "/items?name=Walk", method: "POST" }]);
    expect(last.result?.steps).toEqual([
      { ok: true },
      { ok: true },
      { ok: true },
      { ok: true, value: '"Walk"' },
      { ok: false, error: "Nothing matches #missing." },
    ]);
    expect(last.result?.store).toBe('{"items":["Walk",201]}');
    expect(last.result?.errors).toContainEqual(
      expect.objectContaining({ message: expect.stringContaining("boom"), step: 3 }),
    );
  },
);
