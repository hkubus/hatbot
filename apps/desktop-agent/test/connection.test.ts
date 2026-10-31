import { afterAll, expect, test } from "bun:test";
import { Browser, spare } from "../src/browser";
import { spawn } from "../src/x11";

// A stand-in for Chromium: it answers from a script of what each command does, and can say when the
// browser connection is finished with.
type Answer = { result?: unknown; delayMs?: number; event?: Record<string, unknown> };
let script: (method: string, params: Record<string, unknown>) => Answer = () => ({});
const cdp = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req, srv) {
    if (new URL(req.url).pathname === "/json/version")
      return Response.json({
        webSocketDebuggerUrl: `ws://127.0.0.1:${srv.port}/devtools/browser/x`,
      });
    if (srv.upgrade(req)) return undefined;
    return new Response("not found", { status: 404 });
  },
  websocket: {
    message(ws, raw) {
      const { id, method, params } = JSON.parse(String(raw)) as {
        id: number;
        method: string;
        params: Record<string, unknown>;
      };
      const answer = script(method, params ?? {});
      if (answer.event) ws.send(JSON.stringify(answer.event));
      if (answer.delayMs === undefined)
        ws.send(JSON.stringify({ id, result: answer.result ?? {} }));
      else
        setTimeout(
          () => ws.send(JSON.stringify({ id, result: answer.result ?? {} })),
          answer.delayMs,
        );
    },
  },
});
afterAll(() => cdp.stop(true));

const browser = () => new Browser(null, `http://127.0.0.1:${cdp.port}`);
const TABS = {
  result: {
    targetInfos: [{ targetId: "A", type: "page", url: "https://a/", title: "A" }],
  },
};

test("an answer that comes after its command stopped waiting is let go", async () => {
  script = () => ({ delayMs: 30 });
  const b = browser();
  const answering = b.call("navigate", { url: "https://a/" }).then(
    () => "answered",
    () => "failed",
  );
  expect(await Promise.race([answering, Bun.sleep(10).then(() => "waiting")])).toBe("waiting");
  // Gone with the window: nothing of the command is kept for the answer.
  b.forget(null);
  expect(await answering).toBe("failed");
  script = () => ({});
});

test("a screenshot's answer is taken from the frame, not parsed with it", async () => {
  const png = Buffer.from(
    await (
      await spawn([
        "ffmpeg",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=800x600:rate=1",
        "-frames:v",
        "1",
        "-c:v",
        "png",
        "-f",
        "image2pipe",
        "-",
      ])
    ).out,
  ).toString("base64");
  script = (method) =>
    method === "Page.captureScreenshot"
      ? { result: { data: png } }
      : method === "Target.getTargets"
        ? {
            result: {
              targetInfos: [{ targetId: "A", type: "page", url: "https://a/", title: "A" }],
            },
          }
        : method === "Target.attachToTarget"
          ? { result: { sessionId: "s-A" } }
          : method === "Runtime.evaluate"
            ? { result: { result: { value: "visible" } } }
            : {};
  const b = browser();
  const r = (await b.call("screenshot", {})) as { data: string };
  // Its PNG is over 64 KB, so the frame is read before it's parsed; the WebP is what comes back.
  expect(png.length).toBeGreaterThan(64 * 1024);
  expect(r).toMatchObject({ kind: "image", mediaType: "image/webp" });
  expect(r.data).not.toBe(png);
  expect(Buffer.from(r.data, "base64").subarray(0, 4).toString()).toMatch(/^RIFF$/);
  script = () => ({});
});

test("a page's answer of half a megabyte comes back whole", async () => {
  // About 480 KB of page.
  const lines = Array.from(
    { length: 5000 },
    (_, i) => `- link "Listing ${i}: a graphics card, tested" [ref_${i}] href="https://shop/${i}"`,
  );
  const base = (method: string) =>
    method === "Page.getFrameTree"
      ? { result: { frameTree: { frame: { id: "A", loaderId: "l1" } } } }
      : method === "Page.createIsolatedWorld"
        ? { result: { executionContextId: 3 } }
        : method === "Target.getTargets"
          ? TABS
          : method === "Target.attachToTarget"
            ? { result: { sessionId: "s-A" } }
            : method === "Runtime.evaluate"
              ? { result: { result: { value: { lines, next: 4000, truncated: false } } } }
              : {};
  script = base;
  const b = browser();
  const r = (await b.call("find", { query: "Listing" })) as { kind: string; text: string };
  // The page's answer is over 200 KB, and what comes back of it is whole: find lists 20 at most.
  expect(lines.join("\n").length).toBeGreaterThan(400 * 1024);
  expect(r.kind).toBe("text");
  expect(r.text).toBe(lines.slice(0, 20).join("\n"));
  script = () => ({});
});

test("an answer is read from the frame as the text it stands for", () => {
  const at = '{"id":1,"result":'.length;
  const frame = (value: string) => JSON.stringify({ id: 1, result: { value } });
  for (const value of ["abc", "a}b", 'say "hi"', "one\ntwo", "Kraków \u2600", "😀"])
    expect(spare(frame(value), at)).toBe(value);
  expect(spare(frame("x".repeat(200 * 1024)), at)).toHaveLength(200 * 1024);
  // Not an answer of that shape: the frame is read whole instead.
  expect(spare('{"id":1,"result":{"a":1}}', at)).toBeUndefined();
});
