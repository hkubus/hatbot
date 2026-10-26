// A stand-in for Scout's MCP server, for the negotiation and listing tests: the tools Scout has
// today; with `full`, also the price reference and comparables it doesn't have yet; with `flips`,
// the flips to list, kept in that JSON file, which the tests change; and with `sessions`, the
// marketplace logins shared with Hatbot, kept the same way. Calls are appended to `log`, one
// JSON line each.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export type ScoutOptions = { log?: string; full?: boolean; flips?: string; sessions?: string };

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
      inputSchema: { key: z.string(), watchId: z.string().optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ key }) => {
      log("scout_listing_detail", { key });
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
  if (o.full) {
    server.registerTool(
      "scout_price_reference",
      {
        description: "Scout's typical used asking price for a product",
        inputSchema: { query: z.string(), sources: z.array(z.string()).optional() },
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
        inputSchema: { listingKey: z.string() },
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
  return server;
}
