// The Scout plugin: connecting with a button (MCP's sign-in) and calling Scout's tools with the token
// it got, against a stand-in Scout in the same process.
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginTool } from "@hatbot/plugin-sdk";
import { BOT_TEMPLATES, type Mandate } from "@hatbot/shared";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { runPluginTool, verdictFor } from "../src/plugins/registry";
import { scoutServer } from "./fixtures/scout-tools";
import { ORIGIN, type TestApp, tempDirs, testApp } from "./helpers";

const SCOUT = "http://scout.lan:3001";
const call = () => ({ task: null, signal: new AbortController().signal });

/**
 * Scout's sign-in and its MCP server; `metadata` is what its well-known address says, and `full` adds
 * Scout's price reference, comparables and negotiation outcomes.
 */
function fakeScout(metadata: Record<string, string> | null = {}, full = false) {
  const dir = mkdtempSync(join(tmpdir(), "hatbot-scout-"));
  tempDirs.push(dir);
  const log = join(dir, "calls.jsonl");
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
        await scoutServer({ log, full, flips, sessions }).connect(transport);
        return transport.handleRequest(new Request(url, init));
      }
    }
    return new Response(null, { status: 404 });
  };
  return {
    s,
    handle,
    share: (shared: unknown[]) => writeFileSync(sessions, JSON.stringify(shared)),
    /** What each call to `tool` was given. */
    calls: (tool: string) =>
      existsSync(log)
        ? readFileSync(log, "utf8")
            .trim()
            .split("\n")
            .map((l) => JSON.parse(l) as { tool: string; input: unknown })
            .filter((c) => c.tool === tool)
            .map((c) => c.input)
        : [],
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
  expect(offered).not.toContain("scout_record_outcome");
  await t.listings.tick();
  expect(t.db.query("SELECT bot_id FROM flip_listings").all()).toEqual([{ bot_id: haggler.id }]);

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

test("only the brain tells Scout how a listing or a negotiation went, never a task", async () => {
  const t = await testApp();
  const scout = fakeScout();
  await connected(t, scout);
  const told = [
    ["scout_flip_listed", { flipId: 7, channel: "OLX", status: "declined" }],
    [
      "scout_record_outcome",
      { negotiationId: "hatbot:1", listingKey: "OLX:1001", outcome: "lost", asking: 1500 },
    ],
  ] as const;
  for (const [name, input] of told) {
    const t1 = named(t.plugins.brainTools(), name);
    expect(verdictFor(t1, input, call(), false).action).toBe("allow");
    expect(verdictFor(t1, input, { ...call(), task: { id: 1, tainted: false } }).action).toBe(
      "block",
    );
  }
});

const MANDATE: Mandate = {
  currency: "PLN",
  opening: 1060,
  target: 1250,
  limit: 1400,
  delivery: "OLX delivery with buyer protection",
  expiresAt: "2026-10-16T12:00:00.000Z",
  allow: [],
};

test("through Scout's plugin, a haggle rests on Scout's price reference and comparables, and Scout is told how it ended", async () => {
  const t = await testApp();
  const scout = fakeScout({}, true);
  await connected(t, scout);
  const bot = t.bots.hatbot();
  const tools = t.negotiations.tools(bot, t.plugins.tools(), { conversationId: null });

  // The listing as it is on the marketplace now, and the seller's other listings there.
  const detail = await runPluginTool(
    named(t.plugins.tools(), "scout_listing_detail"),
    { key: "OLX:1001", live: true, sellerListings: true },
    call(),
  );
  expect(JSON.parse(detail.text).liveCheck).toMatchObject({ price: 1450 });
  expect(scout.calls("scout_listing_detail")).toEqual([
    { key: "OLX:1001", live: true, sellerListings: true },
  ]);

  const appraisal = await runPluginTool(
    named(tools, "negotiate_appraise"),
    { listing: "OLX:1001" },
    call(),
  );
  expect(appraisal.text).toContain(`Scout's price reference for "RTX 3070" from 40 listings`);
  // The cheaper comparable is the walk-away, and the lower quartile the aim.
  expect(appraisal.text).toContain("RTX 3070 Gaming OC: 1,290 zł");
  expect(appraisal.text).toContain("aim for 1,200 zł");
  expect(scout.calls("scout_watch_analytics")).toEqual([]);

  const open = (key: string, title: string, currency: string) => {
    const n = t.negotiations.create({
      bot,
      wantId: t.negotiations.wantFor(bot, title, title),
      listing: {
        key,
        marketplace: key.split(":")[0] ?? "",
        title,
        url: `https://example.com/${key}`,
        asking: 1500,
        currency,
        typical: null,
        watchId: null,
        negotiable: true,
        listedAt: null,
        history: [],
      },
      mandate: { ...MANDATE, currency },
      appraisal: null,
      status: "open",
      conversationId: null,
    });
    return n.id;
  };
  const close = named(tools, "negotiate_close");
  const agreed = open("OLX:1001", "Karta graficzna RTX 3070 8GB", "PLN");
  const r = await runPluginTool(
    close,
    { negotiation: agreed, outcome: "agreed", price: 1250 },
    call(),
  );
  expect(r.text).toContain("Scout recorded the outcome.");
  // Scout keeps outcomes in PLN only.
  const euro = open("Vinted:2002", "Kurtka Patagonia M", "EUR");
  await runPluginTool(close, { negotiation: euro, outcome: "lost" }, call());
  expect(scout.calls("scout_record_outcome")).toEqual([
    {
      negotiationId: `hatbot:${agreed}`,
      listingKey: "OLX:1001",
      outcome: "agreed",
      price: 1250,
      asking: 1500,
      currency: "PLN",
    },
  ]);
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

test("Haggler makes a Scout watch for what the owner wants looked for all the time, without asking", async () => {
  const t = await testApp();
  await connected(t, fakeScout());
  const create = named(t.plugins.tools(), "scout_watch_create");
  const input = {
    name: "Steam Deck OLED",
    query: "steam deck oled",
    sources: ["OLX", "Vinted"],
    targetPrice: 1700,
    verificationChecks: [{ text: "not cracked", mode: "require" }],
  };
  expect(verdictFor(create, input, call()).action).toBe("allow");
  const r = await runPluginTool(create, input, call());
  expect(JSON.parse(r.text).watch).toMatchObject({ id: "watch-1", targetPrice: 1700 });
});

test("Hatbot makes a Scout research watch and records a flip without asking", async () => {
  const t = await testApp();
  await connected(t, fakeScout());
  const research = named(t.plugins.tools(), "scout_market_watch_create");
  const watch = { name: "RTX 3080", query: "rtx 3080", sources: ["OLX", "Allegro Lokalnie"] };
  expect(verdictFor(research, watch, call()).action).toBe("allow");
  expect(JSON.parse((await runPluginTool(research, watch, call())).text).watch).toMatchObject({
    id: "market-watch-1",
  });
  const flip = named(t.plugins.tools(), "scout_flip_create");
  const bought = {
    title: "ThinkPad T480",
    buyChannel: "OLX",
    boughtOn: "2026-10-30",
    buyPrice: 600,
  };
  expect(verdictFor(flip, bought, call()).action).toBe("allow");
  expect(JSON.parse((await runPluginTool(flip, bought, call())).text).flip).toMatchObject({
    id: 12,
    buyPrice: 600,
  });
});

test("a Haggler made after Scout is connected lists flips", async () => {
  const t = await testApp();
  await connected(t, fakeScout());
  const template = BOT_TEMPLATES.find((x) => x.id === "haggler");
  if (!template) throw new Error("no Haggler template");
  const { id: _, ...made } = template;
  const haggler = t.bots.create(made);
  await t.listings.tick();
  expect(t.db.query("SELECT bot_id FROM flip_listings").all()).toEqual([{ bot_id: haggler.id }]);
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
