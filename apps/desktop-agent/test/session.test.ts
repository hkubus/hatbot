import { afterAll, beforeAll, expect, test } from "bun:test";
import { Browser } from "../src/browser";
import { type Chromium, startChromium, withChromium } from "./chromium";

const live = test.skipIf(!withChromium);
let chromium: Chromium | null = null;
beforeAll(async () => {
  if (withChromium) chromium = await startChromium();
});
afterAll(() => chromium?.stop());

test("a login from Scout for a site that isn't a marketplace is refused whole", async () => {
  // Nothing listens here: it's refused before Chromium is asked.
  const browser = new Browser(null, "http://127.0.0.1:9");
  const olx = { name: "a", value: "1", domain: ".olx.pl", path: "/" };
  const elsewhere = [
    ".olx.pl.evil.example",
    "evil.example/.olx.pl",
    "evil.example?.olx.pl",
    "evil.example#.olx.pl",
    "evil.example\\.olx.pl",
    "olx.pl.",
  ];
  for (const state of [
    ...elsewhere.map((domain) => ({
      cookies: [olx, { name: "b", value: "2", domain, path: "/" }],
      origins: [],
    })),
    {
      cookies: [olx],
      origins: [{ origin: "https://evil.example", localStorage: [{ name: "k", value: "v" }] }],
    },
    {
      cookies: [olx],
      origins: [{ origin: "http://www.olx.pl", localStorage: [{ name: "k", value: "v" }] }],
    },
  ])
    await expect(browser.signIn(state)).rejects.toThrow(/only be for|isn't an address/);
});

live("a login from Scout signs the profile in", async () => {
  if (!chromium) throw new Error("no Chromium");
  const browser = new Browser(null, chromium.endpoint);
  const r = await browser.signIn({
    cookies: [
      {
        name: "access_token",
        value: "t-1",
        domain: ".olx.pl",
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
        expires: 4_102_444_800,
      },
      { name: "session", value: "s-1", domain: "www.olx.pl", path: "/", expires: -1 },
    ],
    origins: [
      { origin: "https://www.olx.pl", localStorage: [{ name: "user", value: '{"id":7}' }] },
    ],
  });
  expect(r).toEqual({ cookies: 2, origins: 1 });
  const version = (await (await fetch(`${chromium.endpoint}/json/version`)).json()) as {
    webSocketDebuggerUrl: string;
  };
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((ok) => {
    ws.onopen = ok;
  });
  type Answer = {
    cookies?: { name: string; value: string }[];
    targetInfos?: { url: string }[];
    targetId?: string;
    sessionId?: string;
    result?: { value?: unknown };
  };
  let next = 1;
  const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string) =>
    new Promise<Answer>((ok) => {
      const id = next++;
      const on = (e: MessageEvent) => {
        const m = JSON.parse(String(e.data));
        if (m.id !== id) return;
        ws.removeEventListener("message", on);
        ok(m.result ?? m.error);
      };
      ws.addEventListener("message", on);
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  const { cookies = [] } = await send("Storage.getCookies");
  expect(cookies.map((c) => [c.name, c.value]).sort()).toEqual([
    ["access_token", "t-1"],
    ["session", "s-1"],
  ]);
  // The background tab it wrote localStorage in is gone; the profile keeps what it wrote.
  const { targetInfos = [] } = await send("Target.getTargets");
  expect(targetInfos.filter((t) => t.url.includes("olx.pl"))).toEqual([]);
  // Reading it back takes the origin's page too, answered here as well.
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Page.enable", {}, sessionId);
  await send("Fetch.enable", { patterns: [{ urlPattern: "*" }] }, sessionId);
  const asked: string[] = [];
  const loaded = new Promise<void>((ok) => {
    ws.addEventListener("message", (e) => {
      const m = JSON.parse(String(e.data));
      if (m.method === "Fetch.requestPaused") {
        asked.push(m.params.request.url);
        void send(
          "Fetch.fulfillRequest",
          { requestId: m.params.requestId, responseCode: 200, body: "" },
          sessionId,
        );
      }
      if (m.method === "Page.loadEventFired" && asked.length) ok();
    });
  });
  await send("Page.navigate", { url: "https://www.olx.pl/" }, sessionId);
  await loaded;
  const v = await send(
    "Runtime.evaluate",
    { expression: "localStorage.getItem('user')", returnByValue: true },
    sessionId,
  );
  const stored = v.result?.value;
  expect(stored).toBe('{"id":7}');
  ws.close();
});
