import { afterAll, expect, test } from "bun:test";
import { openDb } from "../src/db";
import { DeadManPing } from "../src/ping";
import { testApp } from "./helpers";

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

test("the ping says up once a minute while the database answers, down when it doesn't, and Check everything shows one that failed or stopped", async () => {
  const t = await testApp();
  const check = async () => (await t.checks.run()).results.find((c) => c.id === "ping");
  expect((await check())?.state).toBe("skip");
  const send = t.ping.send.bind(t.ping);
  const sent: ReturnType<typeof send>[] = [];
  t.ping.send = () => {
    const s = send();
    sent.push(s);
    return s;
  };
  t.ping.url = PUSH;
  t.ping.tick();
  expect(await sent[0]).toMatchObject({ status: "up", error: null });
  expect(pings.at(-1)?.searchParams.get("msg")).toBe("OK");
  expect((await check())?.state).toBe("ok");
  // At most once a minute from the 10 s loop; nothing for three minutes, and the loop has stopped.
  t.advance(10_000);
  t.ping.tick();
  expect(sent).toHaveLength(1);
  t.advance(4 * 60_000);
  expect((await check())?.state).toBe("warn");
  // One the monitor doesn't take is kept, not thrown.
  t.ping.url = `http://127.0.0.1:${kuma.port}/api/push/nope`;
  expect((await t.ping.send())?.error).toBe("It answered 404.");
  expect((await check())?.state).toBe("fail");

  const db = openDb(":memory:");
  db.close();
  expect(await new DeadManPing({ db, url: PUSH }).send()).toMatchObject({
    status: "down",
    error: null,
  });
  expect(pings.at(-1)?.searchParams.get("status")).toBe("down");
  expect(pings.at(-1)?.searchParams.get("msg")).toStartWith("Database: ");
});
