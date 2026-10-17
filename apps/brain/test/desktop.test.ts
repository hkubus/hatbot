import { expect, test } from "bun:test";
import { connect, createServer, type Socket } from "node:net";
import { websocket } from "hono/bun";
import { openDb } from "../src/db";
import { Desktop } from "../src/desktop/service";
import { EventBus } from "../src/events";
import { FakeDesktop } from "./fake-desktop";
import { ORIGIN, setUpOwner, testApp, waitFor } from "./helpers";

test("you keep control of the desktop across a brain restart", async () => {
  const db = openDb(":memory:");
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

test("a live viewer that fell behind gets the newest frame once it catches up", async () => {
  const t = await testApp();
  const { cookie } = await setUpOwner(t);
  const watchers = new Set<Bun.ServerWebSocket<unknown>>();
  const agent = Bun.serve({
    port: 0,
    fetch: (req, srv) => (srv.upgrade(req) ? undefined : new Response(null, { status: 400 })),
    websocket: { open: (ws) => void watchers.add(ws), message() {} },
  });
  t.agent.liveSocket = () => ({ url: `ws://127.0.0.1:${agent.port}/live`, headers: {} });
  const brain = Bun.serve({ port: 0, fetch: (req, srv) => t.app.fetch(req, srv), websocket });
  // The viewer's link stops for a while: the brain's frames back up behind it.
  const links: Socket[] = [];
  const link = createServer((viewer) => {
    const up = connect(brain.port ?? 0, "127.0.0.1");
    viewer.pipe(up);
    up.pipe(viewer);
    links.push(up);
  }).listen(0);
  await new Promise((r) => link.once("listening", r));
  const port = (link.address() as { port: number }).port;
  try {
    const got: number[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/desktop/live`, {
      headers: { cookie, origin: ORIGIN },
    } as unknown as string[]);
    ws.binaryType = "arraybuffer";
    ws.onmessage = (e) => got.push(new Uint8Array(e.data as ArrayBuffer)[0] ?? -1);
    await new Promise((r) => (ws.onopen = r));
    await waitFor(() => watchers.size);
    for (const up of links) up.pause();
    // More than the sockets' buffers hold, then the desktop goes still.
    for (let i = 0; i < 100; i++) {
      for (const w of watchers) w.sendBinary(new Uint8Array(100_000).fill(i));
      await Bun.sleep(5);
    }
    await Bun.sleep(200);
    for (const up of links) up.resume();
    await waitFor(() => got.at(-1) === 99, 3000);
    expect(got.length).toBeLessThan(100);
    ws.close();
  } finally {
    brain.stop(true);
    agent.stop(true);
    link.close();
  }
});
