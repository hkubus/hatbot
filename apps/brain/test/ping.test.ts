import { afterAll, expect, test } from "bun:test";
import { openDb } from "../src/db";
import { DeadManPing } from "../src/ping";
import { testApp } from "./helpers";

// A stand-in for an Uptime Kuma Push monitor.
const pings: URL[] = [];
const kuma = Bun.serve({
  port: 0,
  fetch: (req) => {
    const url = new URL(req.url);
    if (url.pathname !== "/api/push/tok") return Response.json({ ok: false }, { status: 404 });
    pings.push(url);
    return Response.json({ ok: true });
  },
});
afterAll(() => kuma.stop(true));
const PUSH = `http://127.0.0.1:${kuma.port}/api/push/tok?status=up&msg=OK&ping=`;

test("the ping says up while the database answers, and down with the error when it doesn't", async () => {
  let now = Date.parse("2026-10-16T10:00:00Z");
  const db = openDb(":memory:");
  const ping = new DeadManPing({ db, url: PUSH, clock: () => now });
  ping.tick();
  await Bun.sleep(50);
  expect(ping.lastPing()?.error).toBeNull();
  expect(pings.at(-1)?.searchParams.get("status")).toBe("up");
  expect(pings.at(-1)?.searchParams.get("msg")).toBe("OK");

  // At most once a minute from the 10 s loop.
  const before = pings.length;
  now += 10_000;
  ping.tick();
  await Bun.sleep(50);
  expect(pings.length).toBe(before);

  db.close();
  now += 60_000;
  const down = await ping.send();
  expect(down?.status).toBe("down");
  expect(down?.error).toBeNull();
  expect(pings.at(-1)?.searchParams.get("status")).toBe("down");
  expect(pings.at(-1)?.searchParams.get("msg")).toStartWith("Database: ");
});

test("a ping that fails is kept, not thrown, and Check everything shows it", async () => {
  const t = await testApp();
  const check = async () => (await t.checks.run()).results.find((c) => c.id === "ping");
  expect((await check())?.state).toBe("skip");

  t.ping.url = "http://127.0.0.1:1/api/push/x";
  expect((await t.ping.send())?.error).toBeTruthy();
  expect((await check())?.state).toBe("fail");

  t.ping.url = `http://127.0.0.1:${kuma.port}/api/push/nope`;
  expect((await t.ping.send())?.error).toBe("It answered 404.");
  expect((await check())?.detail).toContain("404");

  t.ping.url = PUSH;
  await t.ping.send();
  expect((await check())?.state).toBe("ok");
  // Nothing for three minutes: the loop has stopped.
  t.advance(4 * 60_000);
  expect((await check())?.state).toBe("warn");
});
