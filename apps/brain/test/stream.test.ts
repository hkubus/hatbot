import { expect, test } from "bun:test";
import { type HatbotEvent, UNREAD_PER_CHAT } from "@hatbot/shared";
import { websocket } from "hono/bun";
import { bot, ORIGIN, setUpOwner, signIn, testApp } from "./helpers";

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

test("the stream opens with what's live, so an app needn't ask: then paused, for apps from before", async () => {
  const t = await testApp();
  const { cookie } = signIn(t);
  t.bots.update("hatbot", { instructions: "Looks after the homelab.\nAsks before restarting." });
  bot(t, "Chef");
  const chef = t.chats.direct("chef").conversationId;
  const add = t.db.query(
    "INSERT INTO messages (conversation_id, role, kind, text, status, created_at) VALUES (?, 'assistant', 'text', 'Hi', 'done', ?) RETURNING id",
  );
  const said = (chat: number) => (add.get(chat, "2026-10-09T12:00:00Z") as { id: number }).id;
  const hatbot = said(1);
  const chefs = Array.from({ length: UNREAD_PER_CHAT + 1 }, () => said(chef));
  const approval = t.approvals.create({ taskId: null, kind: "other", summary: "Restart the NAS" });
  const brain = Bun.serve({ port: 0, fetch: (req, srv) => t.app.fetch(req, srv), websocket });
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${brain.port}/api/v1/stream`, {
      headers: { cookie, origin: ORIGIN },
    } as unknown as string[]);
    const first: HatbotEvent[] = [];
    await new Promise<void>((done) => {
      ws.onmessage = (e) => {
        if (first.push(JSON.parse(String(e.data))) === 2) done();
      };
    });
    ws.close();
    const [snapshot, paused] = first;
    expect(snapshot).toMatchObject({
      type: "snapshot",
      paused: false,
      approvals: [{ id: approval.id, status: "pending" }],
      questions: [],
      desktop: t.desktop.get(),
      conversations: t.chats.list(),
      // A list's bots carry only their role's first line; GET /bots/:id has it all.
      bots: [
        { id: "hatbot", instructions: "Looks after the homelab.", brief: true },
        { id: "chef" },
      ],
      // Each chat's newest unread: a page's worth and more, not the thousands a chat never read has.
      unread: [hatbot, ...chefs.slice(1)],
    });
    expect(paused).toEqual({ type: "paused", paused: false });
  } finally {
    brain.stop(true);
  }
});
