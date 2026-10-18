import { afterAll, beforeEach, expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import { Browser } from "../src/browser";

// A Chromium DevTools endpoint with two tabs, A on screen and B behind it, that counts visibility checks.
const pages = [
  { targetId: "A", type: "page", url: "https://a.example/", title: "A" },
  { targetId: "B", type: "page", url: "https://b.example/", title: "B" },
];
let visibilityChecks = 0;
/** The tab on screen, and how long each tab takes to say whether it's visible. */
let onScreen = "A";
let answerMs = 0;
let browserSocket: ServerWebSocket<unknown> | null = null;
const cdp = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req, srv) {
    const path = new URL(req.url).pathname;
    if (path === "/json/version")
      return Response.json({
        webSocketDebuggerUrl: `ws://127.0.0.1:${srv.port}/devtools/browser/x`,
      });
    if (srv.upgrade(req)) return undefined;
    return new Response("not found", { status: 404 });
  },
  websocket: {
    open(ws) {
      browserSocket = ws;
    },
    async message(ws, raw) {
      const { id, method, params, sessionId } = JSON.parse(String(raw)) as {
        id: number;
        method: string;
        params: Record<string, unknown>;
        sessionId?: string;
      };
      let result: unknown = {};
      if (method === "Target.getTargets") result = { targetInfos: pages };
      if (method === "Target.attachToTarget") result = { sessionId: `s-${params.targetId}` };
      if (method === "Runtime.evaluate" && params.expression === "document.visibilityState") {
        visibilityChecks++;
        const shown = onScreen;
        await Bun.sleep(answerMs);
        result = { result: { value: sessionId === `s-${shown}` ? "visible" : "hidden" } };
      }
      ws.send(JSON.stringify({ id, result }));
    },
  },
});
afterAll(() => cdp.stop(true));
const endpoint = `http://127.0.0.1:${cdp.port}`;
beforeEach(() => {
  pages.length = 2;
  visibilityChecks = 0;
  onScreen = "A";
  answerMs = 0;
});
/** Sends Chromium's event: it reaches the browser before the answer to its next question. */
const event = (method: string, targetInfo: unknown) =>
  browserSocket?.send(JSON.stringify({ method, params: { targetInfo } }));

test("the tabs are asked which is on screen only when that may have changed", async () => {
  const browser = new Browser(null, endpoint);
  const wait = () => browser.call("wait", { duration: 0 });
  await wait();
  expect(visibilityChecks).toBe(2);
  const tabs = await browser.call("list_tabs", {});
  expect(tabs.kind === "tabs" && tabs.tabs.filter((t) => t.active).map((t) => t.url)).toEqual([
    "https://a.example/",
  ]);
  await wait();
  await wait();
  expect(visibilityChecks).toBe(2);

  // The owner, or the computer toolset, may have switched tabs.
  browser.screenTouched();
  await wait();
  expect(visibilityChecks).toBe(4);
  await wait();
  expect(visibilityChecks).toBe(4);

  // A tab opened by a page.
  const opened = { targetId: "C", type: "page", url: "https://c.example/", title: "C" };
  pages.push(opened);
  event("Target.targetCreated", opened);
  await browser.state();
  expect(visibilityChecks).toBe(7);
  await wait();
  expect(visibilityChecks).toBe(7);
});

test("a call while the tabs are being asked waits for an answer from after the switch", async () => {
  const browser = new Browser(null, endpoint);
  expect((await browser.onScreen(null))?.url).toBe("https://a.example/");
  // The owner switches to B; the tabs are slow to answer, and a second caller comes meanwhile.
  answerMs = 100;
  onScreen = "B";
  browser.screenTouched();
  const [first, second] = await Promise.all([browser.onScreen(null), browser.onScreen(null)]);
  expect([first?.url, second?.url]).toEqual(["https://b.example/", "https://b.example/"]);

  // A page brings a tab to the front without opening or closing one: only its info changes.
  answerMs = 0;
  onScreen = "A";
  event("Target.targetInfoChanged", pages[0]);
  expect((await browser.onScreen(null))?.url).toBe("https://a.example/");
});
