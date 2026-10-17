import { expect, test } from "bun:test";
import type { HatbotEvent } from "@hatbot/shared";
import { websocket } from "hono/bun";
import { batchText } from "../src/routes/stream";
import { ORIGIN, setUpOwner, testApp } from "./helpers";

test("signing out or revoking a token closes its live sockets, and only those", async () => {
  const t = await testApp();
  const { cookie, secret, password } = await setUpOwner(t);
  const app = await t.call("POST", "/auth/login", {
    password,
    totp: t.code(secret),
    client: "app",
    device: "iPhone",
  });
  const { token } = (await app.json()) as { token: string };
  const tokenId = t.auth.listTokens()[0]?.id;
  const brain = Bun.serve({ port: 0, fetch: (req, srv) => t.app.fetch(req, srv), websocket });
  const open = async (headers: Record<string, string>) => {
    const ws = new WebSocket(`ws://127.0.0.1:${brain.port}/api/v1/stream`, {
      headers,
    } as unknown as string[]);
    const closed = new Promise<number>((r) => {
      ws.onclose = (e) => r(e.code);
    });
    await new Promise((r) => {
      ws.onmessage = r;
    });
    return { ws, closed };
  };
  try {
    const web = await open({ cookie, origin: ORIGIN });
    const phone = await open({ authorization: `Bearer ${token}` });
    expect((await t.call("POST", "/auth/logout", {}, { cookie })).status).toBe(200);
    expect(await web.closed).toBe(1008);
    expect(phone.ws.readyState).toBe(WebSocket.OPEN);
    t.auth.deleteToken(tokenId ?? 0);
    expect(await phone.closed).toBe(1008);
  } finally {
    brain.stop(true);
  }
});

test("opening the stream leaves the session's renewal to the next request, which sends the cookie", async () => {
  const t = await testApp();
  const { cookie } = await setUpOwner(t);
  t.advance(2 * 86400_000);
  const brain = Bun.serve({ port: 0, fetch: (req, srv) => t.app.fetch(req, srv), websocket });
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${brain.port}/api/v1/stream`, {
      headers: { cookie, origin: ORIGIN },
    } as unknown as string[]);
    await new Promise((r) => {
      ws.onmessage = r;
    });
    ws.close();
  } finally {
    brain.stop(true);
  }
  const me = await t.call("GET", "/auth/me", undefined, { cookie });
  expect(me.headers.get("set-cookie")).toStartWith(`${cookie};`);
  expect(me.headers.get("set-cookie")).toContain("Max-Age=2592000");
});

test("streamed text goes out together, and before whatever follows it", async () => {
  const sent: HatbotEvent[] = [];
  const batch = batchText((e) => sent.push(e));
  batch.push({ type: "message.delta", id: 1, text: "Hel" });
  batch.push({ type: "task.progress", taskId: 7, text: "Look" });
  batch.push({ type: "message.delta", id: 1, text: "lo" });
  batch.push({ type: "message.progress", id: 1, text: "thinking" });
  batch.push({ type: "task.progress", taskId: 7, text: "ing" });
  expect(sent).toEqual([]);
  await Bun.sleep(80);
  expect(sent).toEqual([
    { type: "message.delta", id: 1, text: "Hello" },
    { type: "task.progress", taskId: 7, text: "Looking" },
    { type: "message.progress", id: 1, text: "thinking" },
  ]);

  sent.length = 0;
  batch.push({ type: "message.delta", id: 2, text: "Done" });
  batch.push({ type: "message.done", id: 2, text: "Done", status: "done" });
  expect(sent.map((e) => e.type)).toEqual(["message.delta", "message.done"]);
  batch.push({ type: "message.delta", id: 3, text: "never" });
  batch.stop();
  await Bun.sleep(80);
  expect(sent).toHaveLength(2);
});
