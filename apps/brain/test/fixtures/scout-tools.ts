// A stand-in for Scout's MCP server, for the negotiation, listing and watch tests: some of Scout's tools;
// with `full`, also its price reference, comparables and negotiation outcomes; with `search`, its live
// search (OLX answers, Vinted is paused, Allegro Lokalnie runs out of time), feed, deals and description
// check; with `flips`,
// the flips to list and the flip ledger, kept in that JSON file, which the tests change; and with `sessions`, the
// marketplace logins shared with Hatbot, kept the same way; and with `inbox`, the marketplace inboxes,
// `{conversations, messages: {[conversationId]: [...]}}`, kept the same way. Calls are appended to
// `log`, one JSON line each.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export type ScoutOptions = {
  log?: string;
  full?: boolean;
  search?: boolean;
  flips?: string;
  sessions?: string;
  inbox?: string;
};

export function scoutServer(o: ScoutOptions): McpServer {
  const log = (tool: string, input: unknown) => {
    if (o.log) appendFileSync(o.log, `${JSON.stringify({ tool, input })}\n`);
  };
  const json = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v) }] });

  const LISTINGS: Record<string, Record<string, unknown>> = {
    "OLX:1001": {
      title: "Karta graficzna RTX 3070 8GB",
      marketplace: "OLX",
      price: 1500,
      typical: 1450,
      watchId: "rtx-3070",
      url: "https://www.olx.pl/d/oferta/karta-rtx-3070-CID99-ID1001.html",
      priceNegotiable: true,
      postedAt: "2026-10-01T10:00:00Z",
      flags: [{ flag: "for_parts", match: "wentylator do wymiany", in: "description" }],
    },
    // A cross-border listing, priced in euro.
    "Vinted:2002": {
      title: "Kurtka Patagonia M",
      marketplace: "Vinted",
      price: 300,
      currency: "EUR",
      url: "https://www.vinted.pl/items/2002-kurtka-patagonia",
      postedAt: "2026-10-01T10:00:00Z",
    },
  };

  const server = new McpServer({ name: "scout", version: "1.0.0" });
  server.registerTool(
    "scout_listing_detail",
    {
      description: "Full detail for one listing",
      inputSchema: {
        key: z.string(),
        watchId: z.string().optional(),
        live: z.boolean().optional(),
        sellerListings: z.boolean().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ key, live, sellerListings }) => {
      log("scout_listing_detail", { key, live, sellerListings });
      const listing = LISTINGS[key];
      if (!listing)
        return {
          isError: true,
          content: [{ type: "text", text: '{"error":"Listing detail is not available yet"}' }],
        };
      return json({
        listing: { ...listing, marketplaceListingKey: key },
        history: [
          { price: 1650, observedAt: "2026-10-01T10:00:00Z" },
          { price: 1500, observedAt: "2026-10-05T10:00:00Z" },
        ],
        firstSeenAt: "2026-10-01T10:00:00Z",
        negotiation: {
          daysListed: 10,
          priceDrops: { count: 1, total: 150 },
          priceNegotiable: true,
          seller: {
            id: "s-1",
            otherListings: {
              source: sellerListings ? "marketplace" : "scout",
              items: [{ key: "OLX:1009", title: "Zasilacz 650W", price: 200 }],
            },
          },
          relists: [],
        },
        liveCheck: live
          ? { availability: { status: "live" }, price: 1450, priceChanged: true }
          : null,
      });
    },
  );
  server.registerTool(
    "scout_watch_analytics",
    {
      description: "Per-watch price analytics",
      inputSchema: { id: z.string(), days: z.number().optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => {
      log("scout_watch_analytics", { id });
      return json({
        watchId: id,
        watchName: "RTX 3070",
        current: {
          medianPrice: 1400,
          lowerPrice: 1250,
          upperPrice: 1550,
          minPrice: 1100,
          maxPrice: 1900,
          listingCount: 31,
        },
      });
    },
  );
  server.registerTool(
    "scout_watch_create",
    {
      description: "Create a deal watch",
      inputSchema: {
        name: z.string(),
        query: z.string(),
        sources: z.array(z.string()),
        targetPrice: z.number().optional(),
        verificationChecks: z.array(z.object({ text: z.string(), mode: z.string() })).optional(),
      },
    },
    async (input) => {
      log("scout_watch_create", input);
      return json({ watch: { id: "watch-1", enabled: true, ...input } });
    },
  );
  server.registerTool(
    "scout_market_watch_create",
    {
      description: "Create a market-research watch",
      inputSchema: { name: z.string(), query: z.string(), sources: z.array(z.string()) },
    },
    async (input) => {
      log("scout_market_watch_create", input);
      return json({ watch: { id: "market-watch-1", enabled: true, ...input } });
    },
  );
  server.registerTool(
    "scout_flip_create",
    {
      description: "Record a flip",
      inputSchema: {
        title: z.string(),
        buyChannel: z.string(),
        boughtOn: z.string(),
        buyPrice: z.number(),
      },
    },
    async (input) => {
      log("scout_flip_create", input);
      return json({ flip: { id: 12, ...input } });
    },
  );
  if (o.full) {
    server.registerTool(
      "scout_price_reference",
      {
        description: "Scout's typical used asking price for a product",
        inputSchema: {
          query: z.string(),
          sources: z.array(z.string()).optional(),
          terms: z.string().optional(),
          excluded: z.string().optional(),
        },
        annotations: { readOnlyHint: true },
      },
      async (input) => {
        log("scout_price_reference", input);
        return json({
          query: input.query,
          best: {
            kind: "watch",
            id: "rtx-3070",
            name: "RTX 3070",
            typicalPrice: 1350,
            p25: 1200,
            p75: 1500,
            samples: 40,
            ready: true,
            basis: "asking prices, own history",
          },
        });
      },
    );
    server.registerTool(
      "scout_comparables",
      {
        description: "Live alternatives for the same item",
        inputSchema: {
          listingKey: z.string(),
          watchId: z.string().optional(),
          limit: z.number().optional(),
        },
        annotations: { readOnlyHint: true },
      },
      async (input) => {
        log("scout_comparables", input);
        return json({
          comparables: [
            {
              title: "RTX 3070 Gaming OC",
              price: 1290,
              url: "https://www.olx.pl/d/oferta/x-ID2002.html",
            },
            { title: "RTX 3070 FE", price: 1380, url: "https://www.olx.pl/d/oferta/y-ID2003.html" },
          ],
        });
      },
    );
    server.registerTool(
      "scout_record_outcome",
      {
        description: "Record how one of your negotiations ended",
        inputSchema: {
          negotiationId: z.string().min(1),
          listingKey: z.string(),
          outcome: z.enum(["agreed", "lost", "abandoned", "expired"]),
          asking: z.number().positive(),
          price: z.number().positive().nullable().optional(),
          currency: z.string().optional(),
        },
        annotations: { readOnlyHint: false },
      },
      async (input) => {
        log("scout_record_outcome", input);
        if (input.currency !== undefined && input.currency !== "PLN")
          return {
            isError: true,
            content: [{ type: "text" as const, text: "Scout records prices in PLN only" }],
          };
        return json({ ...input, created: true });
      },
    );
  }
  if (o.search) {
    const row = {
      id: "OLX:1001",
      source: "OLX",
      title: "Karta graficzna RTX 3070 8GB",
      price: 1500,
      url: "https://www.olx.pl/d/oferta/karta-rtx-3070-CID99-ID1001.html",
      image: null,
      flags: [],
    };
    const flags = z.array(z.string()).optional();
    server.registerTool(
      "scout_search",
      {
        description: "Live manual marketplace search",
        inputSchema: {
          query: z.string(),
          sources: z.array(z.string()),
          page: z.number().optional(),
          excludeFlags: flags,
          typoVariants: z.boolean().optional(),
          ignoreBackoff: z.boolean().optional(),
          deadlineMs: z.number().optional(),
          format: z.string().optional(),
        },
        annotations: { readOnlyHint: true },
      },
      async (input) => {
        log("scout_search", input);
        const source = (name: string) =>
          name === "Vinted" && !input.ignoreBackoff
            ? {
                source: name,
                status: "error",
                errorKind: "backoff",
                message: "Skipped: connector backoff",
                backoffUntil: "2026-10-09T14:30:00.000Z",
              }
            : name === "Allegro Lokalnie"
              ? {
                  source: name,
                  status: "error",
                  errorKind: "deadline",
                  message: "Not finished within the 45 s deadline",
                  backoffUntil: null,
                }
              : {
                  source: name,
                  status: "ok",
                  errorKind: null,
                  message: "1 match",
                  backoffUntil: null,
                };
        const listings = input.sources.includes("OLX") ? [row] : [];
        if (input.format !== "compact") return json({ listings, sources: input.sources });
        return json({
          schemaVersion: 1,
          format: "compact",
          query: input.query,
          page: input.page ?? 1,
          listings: listings.map((l) => ({
            ...l,
            matchedVia: "query",
            jevCheck: null,
            deal: null,
            duplicateCount: 0,
            duplicateCheapest: null,
          })),
          sources: input.sources.map(source),
          typoVariants: null,
          fromCache: false,
          cachedAt: null,
        });
      },
    );
    server.registerTool(
      "scout_listings",
      {
        description: "Query the listings feed",
        inputSchema: {
          q: z.string().optional(),
          excludeFlags: flags,
          format: z.string().optional(),
        },
        annotations: { readOnlyHint: true },
      },
      async (input) => {
        log("scout_listings", input);
        return json({ listings: [row], pagination: { page: 1, pageSize: 20, total: 1 } });
      },
    );
    server.registerTool(
      "scout_deals",
      {
        description: "Strong+ deals right now",
        inputSchema: { excludeFlags: flags, limit: z.number().optional() },
        annotations: { readOnlyHint: true },
      },
      async (input) => {
        log("scout_deals", input);
        return json({ schemaVersion: 1, total: 1, deals: [{ ...row, tier: "strong" }] });
      },
    );
    server.registerTool(
      "scout_verify_listing",
      {
        description: "Run the description check on one stored listing now",
        inputSchema: { key: z.string(), watchId: z.string().optional() },
        annotations: { readOnlyHint: false },
      },
      async (input) => {
        log("scout_verify_listing", input);
        return json({ key: input.key, watch: null, status: "pass", reused: false });
      },
    );
  }
  const flipsFile = o.flips;
  if (flipsFile) {
    type Flip = Record<string, unknown> & {
      id: number;
      updatedAt: string;
      channels: Record<string, string>;
      listed?: Record<string, unknown>[];
    };
    const flips = (): Flip[] => JSON.parse(readFileSync(flipsFile, "utf8"));
    const notFound = { isError: true, content: [{ type: "text" as const, text: "No such flip." }] };
    server.registerTool(
      "scout_flips_to_list",
      {
        description: "Flips marked ready for Hatbot to post, with each marketplace's state",
        inputSchema: {},
        annotations: { readOnlyHint: true },
      },
      async () => {
        log("scout_flips_to_list", {});
        return json({
          flips: flips().map((f) => ({
            id: f.id,
            updatedAt: f.updatedAt,
            channels: Object.entries(f.channels).map(([channel, status]) => ({ channel, status })),
          })),
        });
      },
    );
    server.registerTool(
      "scout_flip",
      {
        description: "One flip's draft",
        inputSchema: { id: z.number() },
        annotations: { readOnlyHint: true },
      },
      async ({ id }) => {
        log("scout_flip", { id });
        const f = flips().find((x) => x.id === id);
        if (!f) return notFound;
        const { channels: _, listed: __, ...draft } = f;
        return json(draft);
      },
    );
    server.registerTool(
      "scout_flip_photo",
      {
        description: "One of a flip's photos",
        inputSchema: { id: z.number() },
        annotations: { readOnlyHint: true },
      },
      async ({ id }) => {
        log("scout_flip_photo", { id });
        return json({
          id,
          mime: "image/jpeg",
          base64: Buffer.from([0xff, 0xd8, id, 0xd9]).toString("base64"),
        });
      },
    );
    server.registerTool(
      "scout_flips",
      {
        description: "The owner's flip ledger",
        inputSchema: { status: z.string().optional(), limit: z.number().optional() },
        annotations: { readOnlyHint: true },
      },
      async (input) => {
        log("scout_flips", input);
        const open = flips().filter((f) => !f.soldOn);
        return json({
          open: {
            count: open.length,
            items: open.map((f) => ({
              id: f.id,
              title: f.title,
              askingPrices: f.askingPrices ?? {},
              breakEven: f.breakEven ?? {},
            })),
          },
        });
      },
    );
    server.registerTool(
      "scout_flip_update",
      {
        description: "Change a flip; record a sale with soldOn, saleChannel and salePrice",
        inputSchema: {
          id: z.number(),
          soldOn: z.string().optional(),
          saleChannel: z.string().optional(),
          salePrice: z.number().optional(),
        },
        annotations: { readOnlyHint: false },
      },
      async (input) => {
        log("scout_flip_update", input);
        const all = flips();
        const f = all.find((x) => x.id === input.id);
        if (!f) return notFound;
        Object.assign(f, input);
        writeFileSync(flipsFile, JSON.stringify(all));
        return json({ flip: f });
      },
    );
    server.registerTool(
      "scout_flip_listed",
      {
        description: "Record where a flip went up on one marketplace, or why it didn't",
        inputSchema: {
          flipId: z.number(),
          channel: z.string(),
          status: z.enum(["listed", "failed", "declined"]),
          url: z.string().optional(),
          error: z.string().optional(),
        },
        annotations: { readOnlyHint: false },
      },
      async (input) => {
        log("scout_flip_listed", input);
        const all = flips();
        const f = all.find((x) => x.id === input.flipId);
        if (!f) return notFound;
        f.channels[input.channel] = input.status;
        f.listed = [...(f.listed ?? []), input];
        writeFileSync(flipsFile, JSON.stringify(all));
        return json({ ok: true });
      },
    );
    // A sold flip's listings, recorded through scout_flip_listed, still up on other marketplaces.
    server.registerTool(
      "scout_flips_to_take_down",
      {
        description: "Sold flips still listed elsewhere",
        inputSchema: {},
        annotations: { readOnlyHint: true },
      },
      async () => {
        log("scout_flips_to_take_down", {});
        return json({
          flips: flips().flatMap((f) => {
            const delisted = (f.delisted as string[] | undefined) ?? [];
            const up = new Map(
              (f.listed ?? [])
                .filter((l) => l.status === "listed" && l.url)
                .map((l) => [String(l.channel), String(l.url)]),
            );
            const channels = [...up]
              .filter(([c]) => c !== f.saleChannel && !delisted.includes(c))
              .map(([channel, url]) => ({ channel, url }));
            return f.soldOn && channels.length
              ? [
                  {
                    id: f.id,
                    title: f.title,
                    soldOn: f.soldOn,
                    saleChannel: f.saleChannel,
                    channels,
                  },
                ]
              : [];
          }),
        });
      },
    );
    server.registerTool(
      "scout_flip_taken_down",
      {
        description: "Tick a sold flip's listing on one marketplace as taken down",
        inputSchema: { flipId: z.number(), channel: z.string() },
        annotations: { readOnlyHint: false },
      },
      async (input) => {
        log("scout_flip_taken_down", input);
        const all = flips();
        const f = all.find((x) => x.id === input.flipId);
        if (!f) return notFound;
        if (!f.soldOn)
          return {
            isError: true,
            content: [{ type: "text" as const, text: `Flip ${f.id} has no sale recorded` }],
          };
        const delisted = (f.delisted as string[] | undefined) ?? [];
        f.delisted = [...new Set([...delisted, input.channel])];
        writeFileSync(flipsFile, JSON.stringify(all));
        return json({ ok: true });
      },
    );
  }
  const sessionsFile = o.sessions;
  if (sessionsFile) {
    type Shared = { marketplace: string; label: string; revision: string; storageState: unknown };
    const shared = (): Shared[] => JSON.parse(readFileSync(sessionsFile, "utf8"));
    server.registerTool(
      "scout_shared_sessions",
      {
        description: "The marketplace sessions shared with connected apps",
        inputSchema: {},
        annotations: { readOnlyHint: true },
      },
      async () => {
        log("scout_shared_sessions", {});
        return json({ sessions: shared().map(({ storageState: _, ...s }) => s) });
      },
    );
    server.registerTool(
      "scout_shared_session",
      {
        description: "One shared marketplace session",
        inputSchema: { marketplace: z.string() },
        annotations: { readOnlyHint: true },
      },
      async ({ marketplace }) => {
        log("scout_shared_session", { marketplace });
        const s = shared().find((x) => x.marketplace === marketplace);
        if (!s) return { isError: true, content: [{ type: "text" as const, text: "Not shared." }] };
        return json(s);
      },
    );
  }
  const inboxFile = o.inbox;
  if (inboxFile) {
    type Inbox = {
      conversations: { id: string }[];
      messages: Record<string, unknown[]>;
    };
    const inbox = (): Inbox => JSON.parse(readFileSync(inboxFile, "utf8"));
    server.registerTool(
      "scout_inbox",
      {
        description: "Your marketplace inbox",
        inputSchema: { marketplace: z.string() },
        annotations: { readOnlyHint: true },
      },
      async ({ marketplace }) => {
        log("scout_inbox", { marketplace });
        const conversations = inbox().conversations.filter((c) =>
          c.id.startsWith(`${marketplace}:`),
        );
        return json({ marketplace, conversations });
      },
    );
    server.registerTool(
      "scout_conversation",
      {
        description: "One conversation's messages",
        inputSchema: { id: z.string() },
        annotations: { readOnlyHint: true },
      },
      async ({ id }) => {
        log("scout_conversation", { id });
        return json({ id, messages: inbox().messages[id] ?? [] });
      },
    );
  }
  return server;
}
