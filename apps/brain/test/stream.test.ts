import { expect, test } from "bun:test";
import { websocket } from "hono/bun";
import { ORIGIN, setUpOwner, testApp } from "./helpers";

test("a live socket closes when its session or token ends, only that one, and leaves the renewal to a request", async () => {
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
    // A socket can't send a cookie back, so opening one leaves the session's renewal to the next request.
    t.advance(2 * 86400_000);
    const web = await open({ cookie, origin: ORIGIN });
    const phone = await open({ authorization: `Bearer ${token}` });
    const me = await t.call("GET", "/auth/me", undefined, { cookie });
    expect(me.headers.get("set-cookie")).toStartWith(`${cookie};`);

    expect((await t.call("POST", "/auth/logout", {}, { cookie })).status).toBe(200);
    expect(await web.closed).toBe(1008);
    expect(phone.ws.readyState).toBe(WebSocket.OPEN);
    t.auth.deleteToken(tokenId ?? 0);
    expect(await phone.closed).toBe(1008);
  } finally {
    brain.stop(true);
  }
});
