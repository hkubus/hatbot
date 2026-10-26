// The Scout plugin: connecting with a button (MCP's sign-in) and calling Scout's tools with the token
// it got, against a stand-in Scout in the same process.
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BOT_TEMPLATES } from "@hatbot/shared";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { PluginTool } from "../src/plugins/plugin";
import { runPluginTool, verdictFor } from "../src/plugins/registry";
import { scoutServer } from "./fixtures/scout-tools";
import { ORIGIN, type TestApp, tempDirs, testApp } from "./helpers";

const SCOUT = "http://scout.lan:3001";
const call = () => ({ task: null, signal: new AbortController().signal });

/** Scout's sign-in and its MCP server; `metadata` is what its well-known address says. */
function fakeScout(metadata: Record<string, string> | null = {}) {
  const dir = mkdtempSync(join(tmpdir(), "hatbot-scout-"));
  tempDirs.push(dir);
  const flips = join(dir, "flips.json");
  const sessions = join(dir, "sessions.json");
  writeFileSync(sessions, "[]");
  writeFileSync(
    flips,
    JSON.stringify([
      {
        id: 7,
        updatedAt: "2026-10-09T10:00:00Z",
        title: "Karta graficzna RTX 3070 8GB",
        description: "Sprawna.",
        condition: "good",
        category: "Karty graficzne",
        delivery: { shipping: true, pickup: false, parcelSize: null },
        prices: { OLX: 1199 },
        currency: "PLN",
        photos: [{ id: 1, mime: "image/jpeg" }],
        channels: { OLX: "ready" },
      },
    ]),
  );
  const s = {
    challenge: "",
    tokens: new Set<string>(),
    bearers: [] as string[],
    posts: [] as string[],
  };
  const handle = async (url: string, init?: RequestInit): Promise<Response> => {
    const u = new URL(url);
    if (u.origin !== SCOUT) return new Response(null, { status: 404 });
    switch (u.pathname) {
      case "/.well-known/oauth-authorization-server":
        return metadata
          ? Response.json({
              issuer: SCOUT,
              authorization_endpoint: `${SCOUT}/oauth/authorize`,
              token_endpoint: `${SCOUT}/oauth/token`,
              registration_endpoint: `${SCOUT}/oauth/register`,
              ...metadata,
            })
          : new Response("Not found", { status: 404 });
      case "/oauth/register":
        return Response.json({ client_id: "c-1" }, { status: 201 });
      case "/oauth/token": {
        const f = new URLSearchParams(String(init?.body));
        const proof = createHash("sha256")
          .update(f.get("code_verifier") ?? "")
          .digest("base64url");
        if (f.get("code") !== "the-code" || proof !== s.challenge)
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        s.tokens.add("scout-token");
        return Response.json({ access_token: "scout-token", token_type: "Bearer" });
      }
      case "/mcp": {
        const auth = new Headers(init?.headers).get("authorization") ?? "";
        s.bearers.push(auth);
        if (init?.method === "POST") s.posts.push(JSON.parse(String(init.body)).method);
        if (!s.tokens.has(auth.replace(/^Bearer /, ""))) return new Response(null, { status: 401 });
        const transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
        await scoutServer({ flips, sessions }).connect(transport);
        return transport.handleRequest(new Request(url, init));
      }
    }
    return new Response(null, { status: 404 });
  };
  return {
    s,
    handle,
    share: (shared: unknown[]) => writeFileSync(sessions, JSON.stringify(shared)),
  };
}

async function connect(t: TestApp, scout: ReturnType<typeof fakeScout>) {
  t.outside.fetch = scout.handle;
  await t.plugins.update("scout", { enabled: true, config: { url: `${SCOUT}/` } });
  const { url } = (await t.plugins.action("scout", "connect", {})) as { url: string };
  return new URL(url);
}

async function connected(t: TestApp, scout: ReturnType<typeof fakeScout>) {
  const go = await connect(t, scout);
  scout.s.challenge = go.searchParams.get("code_challenge") ?? "";
  await t.plugins.action("scout", "finish", {
    code: "the-code",
    state: go.searchParams.get("state"),
  });
}

const named = (tools: PluginTool[], name: string) => {
  const found = tools.find((x) => x.name === name);
  if (!found) throw new Error(`no ${name}`);
  return found;
};

test("connecting lets Hatbot in to Scout with PKCE; Haggler gets Scout, and the listing tools stay the brain's", async () => {
  const t = await testApp();
  const haggler = t.bots.create({
    name: "Haggler",
    instructions: "",
    chatModel: null,
    chatEffort: null,
    plugins: ["self"],
  });
  const scout = fakeScout();

  const go = await connect(t, scout);
  expect(t.plugins.get("scout")?.state).toBe("needs_setup");
  expect(go.origin + go.pathname).toBe(`${SCOUT}/oauth/authorize`);
  expect(go.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/settings/plugins/scout`);
  scout.s.challenge = go.searchParams.get("code_challenge") ?? "";
  await t.plugins.action("scout", "finish", {
    code: "the-code",
    state: go.searchParams.get("state"),
  });
  expect(t.plugins.get("scout")?.state).toBe("ready");
  expect(t.bots.get(haggler.id)?.plugins).toEqual(["self", "scout"]);

  // Strangers' listings: untrusted, with the token Scout gave.
  const r = await runPluginTool(
    named(t.plugins.tools(), "scout_listing_detail"),
    { key: "OLX:1001" },
    call(),
  );
  expect(r.text).toContain("Karta graficzna RTX 3070");
  expect(r.untrusted).toBe(true);
  expect(scout.s.bearers.every((b) => b === "Bearer scout-token")).toBe(true);

  // The model is never offered the flips or their photos; the brain lists them itself.
  const offered = t.plugins.tools().map((x) => x.name);
  expect(offered).not.toContain("scout_flip_photo");
  expect(offered).not.toContain("scout_flip_listed");
  await t.listings.tick();
  expect(t.approvals.list(true).map((a) => [a.kind, a.botId])).toEqual([["listing", haggler.id]]);

  // Disconnected in Scout.
  scout.s.tokens.clear();
  const gone = await runPluginTool(named(t.plugins.tools(), "scout_watches"), {}, call());
  expect(gone.text).toContain("connect it again");
});

test("a Scout that can't connect apps, or sends the sign-in elsewhere, isn't used", async () => {
  const t = await testApp();
  await expect(connect(t, fakeScout(null))).rejects.toThrow("can't connect apps yet");
  await expect(
    connect(t, fakeScout({ authorization_endpoint: "https://evil.example/authorize" })),
  ).rejects.toThrow("somewhere else");
});

test("only the brain tells Scout how a listing went, never a task", async () => {
  const t = await testApp();
  const scout = fakeScout();
  await connected(t, scout);
  const listed = named(t.plugins.brainTools(), "scout_flip_listed");
  const input = { flipId: 7, channel: "OLX", status: "declined" };
  expect(verdictFor(listed, input, call(), false).action).toBe("allow");
  expect(verdictFor(listed, input, { ...call(), task: { id: 1, tainted: false } }).action).toBe(
    "block",
  );
});

test("Scout's calls share one connection, so a flip's photos aren't held back by Scout's rate limit", async () => {
  const t = await testApp();
  const scout = fakeScout();
  await connected(t, scout);
  const photo = named(t.plugins.brainTools(), "scout_flip_photo");
  for (let i = 0; i < 12; i++) await runPluginTool(photo, { id: 1 }, call());
  expect(scout.s.posts.filter((m) => m === "initialize")).toHaveLength(1);
  expect(scout.s.posts.filter((m) => m === "tools/call")).toHaveLength(12);
});

test("a Haggler made after Scout is connected lists flips", async () => {
  const t = await testApp();
  await connected(t, fakeScout());
  const template = BOT_TEMPLATES.find((x) => x.id === "haggler");
  if (!template) throw new Error("no Haggler template");
  const { id: _, ...made } = template;
  const haggler = t.bots.create(made);
  await t.listings.tick();
  expect(t.approvals.list(true).map((a) => [a.kind, a.botId])).toEqual([["listing", haggler.id]]);
});

test("Haggler's tasks sign its browser in with the logins shared in Scout, once each time one is imported", async () => {
  const t = await testApp();
  const haggler = t.bots.create({
    name: "Haggler",
    instructions: "",
    chatModel: null,
    chatEffort: null,
    plugins: ["self"],
  });
  const chef = t.bots.create({
    name: "Chef",
    instructions: "",
    chatModel: null,
    chatEffort: null,
    plugins: ["self"],
  });
  const scout = fakeScout();
  await connected(t, scout);
  const state = (value: string) => ({
    cookies: [{ name: "access_token", value, domain: ".olx.pl", path: "/" }],
    origins: [],
  });
  scout.share([{ marketplace: "OLX", label: "", revision: "r1", storageState: state("one") }]);
  const look = async (botId: string) => {
    t.tasks.createDesktopTask({
      title: "Look",
      goal: "Look",
      successCriteria: "",
      origin: "chat",
      botId,
    });
    await t.tasks.idle();
  };

  // The model is never offered the logins.
  const offered = t.plugins.tools().map((x) => x.name);
  expect(offered).not.toContain("scout_shared_sessions");
  expect(offered).not.toContain("scout_shared_session");

  await look(haggler.id);
  expect(t.agent.signIns).toEqual([{ profile: haggler.id, state: state("one") }]);
  // Not again for the same import, nor in a bot without Scout.
  t.advance(10 * 60_000);
  await look(haggler.id);
  await look(chef.id);
  expect(t.agent.signIns).toHaveLength(1);

  scout.share([{ marketplace: "OLX", label: "", revision: "r2", storageState: state("two") }]);
  t.advance(10 * 60_000);
  await look(haggler.id);
  expect(t.agent.signIns.map((x) => x.state)).toEqual([state("one"), state("two")]);

  // A desktop with one profile for every bot: Haggler's login would be all of theirs.
  t.agent.oneProfile = true;
  scout.share([{ marketplace: "OLX", label: "", revision: "r3", storageState: state("three") }]);
  t.advance(10 * 60_000);
  await look(haggler.id);
  expect(t.agent.signIns).toHaveLength(2);
});
