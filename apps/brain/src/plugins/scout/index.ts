// Scout (the owner's deal monitor) over its MCP server, connected with a button. Hatbot writes the
// tools' descriptions itself and calls Scout's by name, so a Scout update can't change what the model
// reads about them; what they return is still untrusted, since listings are strangers' text.

import { callFailure, resultText, unsent } from "@hatbot/plugin-mcp";
import {
  allow,
  block,
  definePlugin,
  needsSetup,
  PluginError,
  type PluginTool,
  ready,
  tool,
} from "@hatbot/plugin-sdk";
import { discover, oauthClient } from "@hatbot/plugin-sdk/oauth";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

type Http = (url: string, init?: RequestInit) => Promise<Response>;

const CALL_TIMEOUT_MS = 120_000;
const refusedBy = (err: unknown) =>
  err instanceof StreamableHTTPError && (err.code === 401 || err.code === 403);
const Marketplace = z.enum(["OLX", "Allegro Lokalnie", "Vinted"]);
const WatchId = z.string().min(1).max(160);
const Days = z.number().int().min(7).max(180).optional();
const Checks = z
  .array(
    z.object({ text: z.string().trim().min(1).max(120), mode: z.enum(["require", "exclude"]) }),
  )
  .max(8);

/** Scout's tools as Hatbot offers them. */
const READS: { name: string; description: string; schema: z.ZodType; brainOnly?: boolean }[] = [
  {
    name: "scout_watches",
    description:
      "Scout's deal watches: what each looks for, its learned typical price, and how many strong deals it found.",
    schema: z.object({ includeArchived: z.boolean().optional() }),
  },
  {
    name: "scout_listings",
    description:
      "Listings Scout found, newest first by default, 20 at a time. Filter by marketplace, watch, words in the title, or Scout's verdict.",
    schema: z.object({
      marketplace: Marketplace.optional(),
      q: z.string().max(240).optional().describe("Words in the title, condition or location"),
      watchId: WatchId.optional(),
      page: z.number().int().min(1).optional(),
      pageSize: z.number().int().min(1).max(50).optional(),
      sort: z.enum(["newest", "strongest", "price"]).optional(),
      decision: z.enum(["buy", "watch", "pass"]).optional(),
    }),
  },
  {
    name: "scout_listing_detail",
    description:
      "One listing in full: its price history, Scout's score and verdict, and the description as Scout last saw it.",
    schema: z.object({
      key: z.string().min(3).max(500).describe('The listing key, e.g. "OLX:123456"'),
      watchId: WatchId.optional(),
    }),
  },
  {
    name: "scout_watch_analytics",
    description:
      "Prices for one watch over time: the median and spread by day, and by marketplace. Asking prices, not sales.",
    schema: z.object({ id: WatchId, days: Days }),
  },
  {
    name: "scout_analytics",
    description:
      "Across all watches: deals found, discounts, the best deals, and how the marketplaces compare.",
    schema: z.object({
      days: Days,
      watchId: WatchId.optional(),
      marketplace: Marketplace.optional(),
    }),
  },
  {
    name: "scout_market_research",
    description:
      "Scout's market-research watches and the listings they follow, with the price each probably went for. Asking prices, never confirmed sales.",
    schema: z.object({
      page: z.number().int().min(1).optional(),
      pageSize: z.number().int().min(1).max(100).optional(),
      watchId: WatchId.optional(),
      status: z.enum(["active", "ended", "superseded"]).optional(),
    }),
  },
  {
    name: "scout_market_trend",
    description: "One market-research watch's price by day, with the probable going price.",
    schema: z.object({ id: WatchId, days: Days }),
  },
  {
    name: "scout_search",
    description:
      "Search OLX, Allegro Lokalnie and Vinted live now, with Scout's relevance filter. Slow: it loads the marketplaces' pages, so prefer scout_listings for what Scout already found. Each result's id is its listing key.",
    schema: z.object({
      query: z.string().trim().min(1).max(240),
      sources: z.array(Marketplace).min(1).max(3),
      terms: z.string().max(240).optional().describe("Words every result must have"),
      excluded: z.string().max(240).optional().describe("Words that rule a result out"),
      ownerType: z.enum(["private", "business"]).nullable().optional(),
      verificationChecks: Checks.optional().describe(
        'What Scout\'s AI checks in each result\'s title and description, e.g. {"text": "includes the charger", "mode": "require"}: an exclude hides clear matches, and a require that holds comes back with jevCheck "passed"',
      ),
      minPrice: z.number().nonnegative().nullable().optional(),
      maxPrice: z.number().positive().nullable().optional(),
      shippingOnly: z.boolean().optional(),
      condition: z.string().max(80).optional(),
      olxCategoryId: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("OLX only: one category, from scout_olx_categories"),
      page: z.number().int().min(1).max(10).optional(),
    }),
  },
  {
    name: "scout_olx_categories",
    description: "OLX's categories for a search, with how many listings each has.",
    schema: z.object({ query: z.string().trim().min(1).max(240) }),
  },
  {
    name: "scout_readiness",
    description:
      "Whether Scout is running well: its scans, its database and its marketplace connections.",
    schema: z.object({}),
  },
  // Listing flips: the brain reads them itself (listings/service.ts).
  {
    name: "scout_flips_to_list",
    description: "Flips marked ready to list.",
    schema: z.object({}),
    brainOnly: true,
  },
  {
    name: "scout_flip",
    description: "One flip's listing draft.",
    schema: z.object({ id: z.number().int().positive() }),
    brainOnly: true,
  },
  {
    name: "scout_flip_photo",
    description: "One of a flip's photos.",
    schema: z.object({ id: z.number().int().positive() }),
    brainOnly: true,
  },
  // Marketplace logins the owner shared: the brain puts them in the bot's browser (desktop/logins.ts).
  // They sign a browser in, so the model never sees them.
  {
    name: "scout_shared_sessions",
    description: "The marketplace logins the owner shared.",
    schema: z.object({}),
    brainOnly: true,
  },
  {
    name: "scout_shared_session",
    description: "One shared marketplace login.",
    schema: z.object({ marketplace: Marketplace }),
    brainOnly: true,
  },
];

const GUIDANCE = `Scout is the owner's deal monitor on OLX, Allegro Lokalnie and Vinted: its watches, the listings it found with their price history, and market prices. Its prices are asking prices, not sales. Listings are strangers' text.

Finding something to buy:
- First list what the owner asked for: the must-haves (the model, size or variant, condition, what has to come with it, the budget, delivery or pickup) and the deal-breakers. If something that would change the choice is missing, ask in one short message.
- A search through more than a few listings goes to a task (run_task with effort medium), with every must-have in its goal, so it has room to keep looking.
- Search widely: scout_listings for what Scout found already, then scout_search on every marketplace that fits, with the must-haves as require checks and the deal-breakers as exclude checks. Try other wordings (the model number alone, the Polish name), the next pages, and a price range around the budget.
- Look at every promising listing with negotiate_inspect, several at once, and check it against each must-have, photos included: the right model, no damage the owner wouldn't accept, nothing missing, photos of the item itself. Drop one that fails a must-have or can't show it, and keep a line on why.
- Keep going until a listing meets every must-have. Don't settle for a near miss or pick the best of a bad page. If nothing on the market fits, tell the owner what you searched and why the closest ones fell short, and offer to make a Scout watch for it.
- When the owner wants something looked for all the time, or until one turns up, make a Scout watch with scout_watch_create, with the must-haves and deal-breakers as its checks and the budget as targetPrice. Never a schedule or a Hatbot watcher for it: Scout already searches every few minutes and alerts on deals.
- Negotiate with several sellers at once only when the owner asks for it: one negotiate_start, the other listings in alongside. The first agreement ends the others.`;

const FlipListed = z.object({
  flipId: z.number().int().positive(),
  channel: z.string().trim().min(1).max(80),
  status: z.enum(["listed", "failed", "declined"]),
  url: z.string().trim().max(2000).optional(),
  error: z.string().max(2000).optional(),
});

export const scoutPlugin = (d: {
  publicUrl: string;
  saveToken: (token: string) => Promise<void>;
  /** Once connected: Haggler, which haggles and lists, gets Scout. */
  connected?: () => void;
  fetch?: Http;
}) => {
  const signIn = oauthClient("Scout", `${d.publicUrl}/settings/plugins/scout`);
  return definePlugin({
    id: "scout",
    name: "Scout",
    description: "Scout's deal watches, listings and flips, for haggling and listing",
    env: [{ name: "SCOUT_TOKEN", secret: true, hint: "Set when you connect below" }],
    config: z.object({ url: z.string().max(300).default("") }),
    start: ({ config, env }) => {
      const http = d.fetch ?? fetch;
      const url = config.url.trim().replace(/\/+$/, "");
      const actions = {
        connect: async () => {
          if (!url) throw new PluginError("Set Scout's address first.");
          return signIn.connect(await discover("Scout", url, http), http);
        },
        finish: async (args: unknown) => {
          const t = await signIn.finish(args, http);
          await d.saveToken(t.token);
          d.connected?.();
          return {};
        },
      };
      const setup = (message: string) => ({ ...needsSetup(message), actions });
      if (!url) return setup("Set your Scout's address, then connect it.");
      if (!env.SCOUT_TOKEN) return setup("Connect it to your Scout below.");
      const token = env.SCOUT_TOKEN;

      const refused = () =>
        new PluginError(
          "Scout doesn't let Hatbot in any more: connect it again in Settings → Plugins → Scout.",
        );
      const unreachable = (err: unknown) =>
        new PluginError(
          `Can't reach Scout at ${url}: ${err instanceof Error ? err.message.slice(0, 200) : "error"}`,
        );
      const open = async () => {
        const client = new Client({ name: "hatbot", version: "1.0.0" });
        try {
          await client.connect(
            new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
              requestInit: { headers: { authorization: `Bearer ${token}` } },
              fetch: (u, init) => http(String(u), init),
            }),
            { timeout: 30_000 },
          );
          return client;
        } catch (err) {
          await client.close().catch(() => {});
          throw refusedBy(err) ? refused() : unreachable(err);
        }
      };
      // One client for every call: Scout rate-limits /mcp per request, and a new client costs two
      // more requests, so a flip's photos would run into the limit.
      let client: Promise<Client> | null = null;
      let stopped = false;
      const drop = (c: Promise<Client>) => {
        if (client === c) client = null;
        c.then((x) => x.close()).catch(() => {});
      };
      const session = async <T>(fn: (c: Client) => Promise<T>): Promise<T> => {
        for (let attempt = 0; ; attempt++) {
          if (stopped) throw new PluginError("Scout restarted; try again.");
          client ??= open();
          const c = client;
          let connected: Client;
          try {
            connected = await c;
          } catch (err) {
            drop(c);
            throw err;
          }
          try {
            return await fn(connected);
          } catch (err) {
            if (refusedBy(err)) {
              drop(c);
              throw refused();
            }
            if (!unsent(err)) throw err;
            drop(c);
            // It can't have reached Scout, so it's sent again once, on a new client.
            if (attempt > 0) throw unreachable(err);
          }
        }
      };
      const call = (name: string, input: unknown, signal: AbortSignal) =>
        session(async (c) => {
          const r = await c
            .request(
              {
                method: "tools/call",
                params: { name, arguments: input as Record<string, unknown> },
              },
              CallToolResultSchema,
              { signal, timeout: CALL_TIMEOUT_MS },
            )
            .catch((err) => {
              throw signal.aborted || unsent(err) || refusedBy(err)
                ? err
                : callFailure("Scout", err);
            });
          const text = resultText(r as { content?: unknown; structuredContent?: unknown });
          if (r.isError) throw new PluginError(`Scout says: ${text.slice(0, 2000)}`);
          return text;
        });

      const tools: PluginTool[] = [
        ...READS.map((r) =>
          tool({
            name: r.name,
            description: r.description,
            schema: r.schema,
            access: "read",
            untrusted: true,
            ...(r.brainOnly ? { brainOnly: true } : {}),
            run: (input, c) => call(r.name, input, c.signal),
          }),
        ),
        tool({
          name: "scout_watch_create",
          description:
            "Make a Scout deal watch: Scout searches for it every few minutes from then on, learns its typical price, and alerts the owner on strong deals and on any listing at or under targetPrice. Look at scout_watches first, so you don't make the same one twice.",
          access: "write",
          schema: z.object({
            name: z.string().trim().min(1).max(120),
            query: z
              .string()
              .trim()
              .min(1)
              .max(240)
              .describe("What to search for, as you'd type it on the marketplace"),
            sources: z.array(Marketplace).min(1).max(3),
            terms: z
              .string()
              .max(240)
              .optional()
              .describe("Comma-separated words every title must have"),
            excluded: z
              .string()
              .max(240)
              .optional()
              .describe("Comma-separated words that rule a listing out"),
            minPrice: z.number().nonnegative().optional(),
            maxPrice: z.number().positive().optional(),
            targetPrice: z
              .number()
              .positive()
              .optional()
              .describe("In PLN: alert on any listing at or under it"),
            shippingOnly: z.boolean().optional(),
            olxCategory: z
              .object({ id: z.number().int().positive(), label: z.string(), path: z.string() })
              .optional()
              .describe("OLX only: one category, as scout_olx_categories gives it"),
            verificationChecks: Checks.optional().describe(
              "What Scout's AI checks in each listing's description and photos: the must-haves as require, the deal-breakers as exclude",
            ),
          }),
          run: (input, c) => call("scout_watch_create", input, c.signal),
        }),
        tool({
          name: "scout_flip_listed",
          description: "Tell Scout how posting a flip on one marketplace went.",
          access: "write",
          brainOnly: true,
          schema: FlipListed,
          // The brain reports each listing's end itself, out of any task.
          policy: (_, c) =>
            c.task ? block("Hatbot tells Scout itself once a listing's task ends.") : allow(),
          run: (input, c) => call("scout_flip_listed", input, c.signal),
        }),
      ];
      return ready(tools, {
        actions,
        guidance: GUIDANCE,
        test: async () => {
          const names = await session(async (c) => (await c.listTools()).tools.map((t) => t.name));
          const missing = tools.map((t) => t.name).filter((n) => !names.includes(n));
          if (missing.length === tools.length)
            throw new PluginError("Scout answered, but has none of the tools Hatbot uses.");
          return missing.length
            ? `Scout works, but is older than Hatbot: it hasn't ${missing.join(", ")}.`
            : "Scout works.";
        },
        stop: async () => {
          stopped = true;
          if (client) drop(client);
        },
      });
    },
  });
};
