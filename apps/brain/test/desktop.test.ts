import { expect, test } from "bun:test";
import { Desktop, frameRelay } from "@hatbot/plugin-desktop";
import { websocket } from "hono/bun";
import { EventBus } from "../src/events";
import { FakeDesktop } from "./fake-desktop";
import { ORIGIN, signIn, testApp } from "./helpers";

test("you keep control of the desktop across a brain restart", async () => {
  const kept = new Map<string, string | null>();
  const db = {
    get: (k: string) => kept.get(k) ?? null,
    set: (k: string, v: string | null) => kept.set(k, v),
  };
  const agent = new FakeDesktop();
  const first = new Desktop(agent, new EventBus(), db);
  await first.takeover();
  expect(agent.locked).toBe(true);

  // desktop-agent restarted too and came back unlocked.
  agent.locked = false;
  const again = new Desktop(agent, new EventBus(), db);
  expect(again.get().control).toBe("owner");
  await again.setPaused(false);
  await again.refresh();
  expect(agent.locked).toBe(true);

  await again.handback();
  expect(new Desktop(agent, new EventBus(), db).get().control).toBe("hatbot");
  expect(agent.locked).toBe(false);
});

test("a live viewer that fell behind gets the newest frame once it catches up", () => {
  const sent: number[] = [];
  let buffered = 1 << 20;
  let retry: (() => void) | undefined;
  const relay = frameRelay(
    (f) => sent.push(new Uint8Array(f)[0] ?? -1),
    () => buffered,
    (fn) => {
      retry = fn;
    },
  );
  for (let i = 1; i <= 3; i++) relay.push(new Uint8Array([i]).buffer);
  expect(sent).toEqual([]);
  retry?.();
  expect(sent).toEqual([]);
  buffered = 0;
  retry?.();
  expect(sent).toEqual([3]);
});

test("the live view is only for the signed-in, from Hatbot's address, and closes when they sign out", async () => {
  const t = await testApp();
  const { cookie } = signIn(t);
  const upstream = Bun.serve({
    port: 0,
    fetch: (req, srv) => (srv.upgrade(req) ? undefined : new Response(null, { status: 400 })),
    websocket: {
      open: (ws) => {
        ws.send(new Uint8Array([7]));
      },
      message: () => {},
    },
  });
  t.agent.liveSocket = () => ({ url: `ws://127.0.0.1:${upstream.port}/live`, headers: {} });
  const brain = Bun.serve({ port: 0, fetch: (req, srv) => t.app.fetch(req, srv), websocket });
  const url = `127.0.0.1:${brain.port}/api/v1/desktop/live`;
  try {
    expect((await fetch(`http://${url}`)).status).toBe(401);
    const elsewhere = await fetch(`http://${url}`, {
      headers: { cookie, origin: "https://evil.test" },
    });
    expect(elsewhere.status).toBe(403);

    const ws = new WebSocket(`ws://${url}`, {
      headers: { cookie, origin: ORIGIN },
    } as unknown as string[]);
    ws.binaryType = "arraybuffer";
    const closed = new Promise<number>((r) => {
      ws.onclose = (e) => r(e.code);
    });
    const frame = await new Promise<MessageEvent>((r) => {
      ws.onmessage = r;
    });
    expect([...new Uint8Array(frame.data as ArrayBuffer)]).toEqual([7]);

    expect((await t.call("POST", "/auth/logout", {}, { cookie })).status).toBe(200);
    expect(await closed).toBe(1008);
  } finally {
    brain.stop(true);
    upstream.stop(true);
  }
});
