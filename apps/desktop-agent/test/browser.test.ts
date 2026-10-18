import { afterAll, expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import { Browser } from "../src/browser";

// A Chromium DevTools endpoint with two tabs, A on screen and B behind it.
const pages = [
  { targetId: "A", type: "page", url: "https://a.example/", title: "A" },
  { targetId: "B", type: "page", url: "https://b.example/", title: "B" },
];
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
        const shown = onScreen;
        await Bun.sleep(answerMs);
        result = { result: { value: sessionId === `s-${shown}` ? "visible" : "hidden" } };
      }
      ws.send(JSON.stringify({ id, result }));
    },
  },
});
afterAll(() => cdp.stop(true));

test("a call while the tabs are being asked waits for an answer from after the switch", async () => {
  const browser = new Browser(null, `http://127.0.0.1:${cdp.port}`);
  expect((await browser.onScreen(null))?.url).toBe("https://a.example/");
  // The owner switches to B; the tabs are slow to answer, and a second caller comes meanwhile.
  answerMs = 100;
  onScreen = "B";
  browser.screenTouched();
  const [first, second] = await Promise.all([browser.onScreen(null), browser.onScreen(null)]);
  expect([first?.url, second?.url]).toEqual(["https://b.example/", "https://b.example/"]);

  // A page brings a tab to the front without opening or closing one: only its info changes. Chromium's
  // event reaches the browser before the answer to its next question.
  answerMs = 0;
  onScreen = "A";
  browserSocket?.send(
    JSON.stringify({ method: "Target.targetInfoChanged", params: { targetInfo: pages[0] } }),
  );
  expect((await browser.onScreen(null))?.url).toBe("https://a.example/");
});
