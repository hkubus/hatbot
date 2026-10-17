import { afterAll, expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";

// A Chromium DevTools endpoint with two tabs, A on screen and B behind it, that counts visibility checks.
const pages = [
  { targetId: "A", type: "page", url: "https://a.example/", title: "A" },
  { targetId: "B", type: "page", url: "https://b.example/", title: "B" },
];
let visibilityChecks = 0;
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
    message(ws, raw) {
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
        result = { result: { value: sessionId === "s-A" ? "visible" : "hidden" } };
      }
      ws.send(JSON.stringify({ id, result }));
    },
  },
});
afterAll(() => cdp.stop(true));
process.env.HATBOT_CDP = `http://127.0.0.1:${cdp.port}`;
// Its own copy of the module: another test file may have loaded it with another DevTools address.
const { Browser } = (await import(
  `../src/browser.ts?cdp=${cdp.port}`
)) as typeof import("../src/browser");

test("the tabs are asked which is on screen only when that may have changed", async () => {
  const browser = new Browser(null);
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
  browserSocket?.send(
    JSON.stringify({ method: "Target.targetCreated", params: { targetInfo: opened } }),
  );
  await Bun.sleep(20);
  await wait();
  expect(visibilityChecks).toBe(7);
  await browser.state();
  expect(visibilityChecks).toBe(7);
});
