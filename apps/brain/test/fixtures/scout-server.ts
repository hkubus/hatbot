// A stand-in for Scout's MCP server over stdio, for the negotiation tests. It has the tools Scout has
// today; with SCOUT_FULL=1, also the price reference and comparables it doesn't have yet (PLAN.md §16.4).
// Calls are appended to SCOUT_LOG, one JSON line each.
import { appendFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const log = (tool: string, input: unknown) => {
  if (process.env.SCOUT_LOG)
    appendFileSync(process.env.SCOUT_LOG, `${JSON.stringify({ tool, input })}\n`);
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
if (process.env.SCOUT_FULL) {
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
await server.connect(new StdioServerTransport());
