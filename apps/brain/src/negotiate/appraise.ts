// Scout's tools are called by name through the MCP plugin, as watchers call plugin tools; only ones set
// to Chat (read) are used, so nothing here asks.
import type { Appraisal, AppraisalSource } from "@hatbot/shared";
import { PluginError, type PluginTool } from "../plugins/plugin";
import { zl } from "./policy";

export type ListingFacts = {
  key: string;
  marketplace: string;
  title: string;
  url: string;
  asking: number | null;
  currency: string;
  typical: number | null;
  watchId: string | null;
  negotiable: boolean | null;
  listedAt: string | null;
  history: { price: number; at: string }[];
};

/** By name suffix: mcp_<server>_scout_listing_detail. */
export const scoutTool = (tools: PluginTool[], name: string) =>
  tools.find((t) => t.name === name || t.name.endsWith(`_${name}`));

export function parseKey(key: string): { marketplace: string; id: string } | null {
  const i = key.indexOf(":");
  if (i < 1 || i === key.length - 1) return null;
  return { marketplace: key.slice(0, i).trim(), id: key.slice(i + 1).trim() };
}

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const currencyOf = (c: string | null) => {
  const code = (c ?? "PLN").trim().toUpperCase();
  return code === "ZŁ" || code === "ZL" ? "PLN" : code;
};

/** It must only read: set to Chat in Settings. */
export async function readScout(
  t: PluginTool,
  input: Record<string, unknown>,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  if (t.access !== "read")
    throw new PluginError(
      `${t.name} asks before each use. Set it to Chat in Settings → Plugins → MCP, so Hatbot can read it.`,
    );
  const parsed = t.schema.safeParse(input);
  if (!parsed.success) throw new PluginError(`${t.name} doesn't take ${JSON.stringify(input)}.`);
  const out = await t.run(parsed.data, { task: null, signal });
  try {
    return obj(JSON.parse(out));
  } catch {
    throw new PluginError(`${t.name}'s answer wasn't JSON: ${out.slice(0, 200)}`);
  }
}

export async function listingFacts(
  tools: PluginTool[],
  key: string,
  signal: AbortSignal,
): Promise<ListingFacts> {
  const parts = parseKey(key);
  if (!parts) throw new PluginError(`"${key}" isn't a listing key like "OLX:123456".`);
  const detail = scoutTool(tools, "scout_listing_detail");
  if (!detail)
    throw new PluginError("Scout isn't connected: connect it in Settings → Plugins → Scout.");
  const d = await readScout(detail, { key }, signal);
  const l = obj(d.listing);
  const url = str(l.url) ?? str(obj(d.descriptionSnapshot).url);
  if (!url) throw new PluginError(`Scout has no address for ${key}.`);
  const history = (Array.isArray(d.history) ? d.history : [])
    .map((p) => obj(p))
    .flatMap((p) => {
      const price = num(p.price);
      const at = str(p.observedAt);
      return price && at ? [{ price, at }] : [];
    });
  return {
    key,
    marketplace: str(l.marketplace) ?? parts.marketplace,
    title: str(l.title) ?? str(obj(d.descriptionSnapshot).title) ?? key,
    url,
    asking: num(l.price) ?? num(obj(d.descriptionSnapshot).price),
    currency: currencyOf(str(l.currency) ?? str(obj(d.descriptionSnapshot).currency)),
    typical: num(l.typical),
    watchId: str(l.watchId),
    negotiable: typeof l.priceNegotiable === "boolean" ? l.priceNegotiable : null,
    listedAt: str(l.postedAt) ?? str(l.firstSeenAt) ?? str(d.firstSeenAt),
    history,
  };
}

export function roundPrice(x: number, dir: "down" | "near" = "near"): number {
  const step = x < 200 ? 5 : x < 2000 ? 10 : 50;
  const f = dir === "down" ? Math.floor : Math.round;
  return Math.max(step, f(x / step) * step);
}

export async function appraise(
  tools: PluginTool[],
  key: string,
  signal: AbortSignal,
  now: Date,
): Promise<{ listing: ListingFacts; appraisal: Appraisal }> {
  const listing = await listingFacts(tools, key, signal);
  const sources: AppraisalSource[] = [];
  const notes: string[] = [];
  const usable = (name: string) => {
    const t = scoutTool(tools, name);
    if (t && t.access !== "read") {
      notes.push(`${name} isn't set to Chat in Settings, so it wasn't asked`);
      return null;
    }
    return t ?? null;
  };

  let typical: number | null = null;
  let low: number | null = null;
  let basis = "";

  const reference = usable("scout_price_reference");
  if (reference) {
    const r = await readScout(
      reference,
      { query: listing.title.slice(0, 240), sources: [listing.marketplace] },
      signal,
    ).catch(() => ({}) as Record<string, unknown>);
    const best = obj(r.best);
    if (num(best.typicalPrice)) {
      typical = num(best.typicalPrice);
      const p25 = num(best.p25);
      low = p25 !== null && typical !== null && p25 <= typical ? p25 : null;
      const samples = typeof best.samples === "number" ? best.samples : null;
      basis = `Scout's price reference for "${str(best.name) ?? listing.title}"${samples !== null ? ` from ${samples} listings` : ""}`;
      sources.push({
        label: `Typical price (${str(best.basis) ?? "Scout"}${best.ready === false ? ", not ready" : ""})`,
        price: typical,
        url: null,
      });
      if (low !== null) sources.push({ label: "Lower quartile", price: low, url: null });
    }
  }

  const analytics = usable("scout_watch_analytics");
  if (typical === null && analytics && listing.watchId) {
    const a = await readScout(analytics, { id: listing.watchId }, signal).catch(
      () => ({}) as Record<string, unknown>,
    );
    const current = obj(a.current);
    const median = num(current.medianPrice);
    if (median) {
      typical = median;
      const lower = num(current.lowerPrice);
      low = lower !== null && lower <= median ? lower : null;
      const count = typeof current.listingCount === "number" ? current.listingCount : null;
      basis = `Scout's watch "${str(a.watchName) ?? listing.watchId}": today's median asking price${count !== null ? ` over ${count} listings` : ""}`;
      sources.push({ label: "Median asking price", price: median, url: null });
      if (low !== null) sources.push({ label: "Lower band", price: low, url: null });
      const min = num(current.minPrice);
      if (min) sources.push({ label: "Cheapest listed now", price: min, url: null });
    }
  }
  if (typical === null && listing.typical) {
    typical = listing.typical;
    basis = "Scout's typical price for the watch that found it";
    sources.push({ label: "Typical price", price: typical, url: null });
  }

  const comparables = usable("scout_comparables");
  let cheapest: number | null = null;
  if (comparables) {
    const c = await readScout(comparables, { listingKey: key }, signal).catch(
      () => ({}) as Record<string, unknown>,
    );
    const list = [c.comparables, c.listings, c.items].find(Array.isArray) as unknown[] | undefined;
    for (const item of (list ?? []).slice(0, 5)) {
      const o = obj(item);
      const price = num(o.price);
      if (!price) continue;
      sources.push({ label: str(o.title) ?? "Comparable listing", price, url: str(o.url) });
      cheapest = cheapest === null ? price : Math.min(cheapest, price);
    }
  }

  const asking = listing.asking;
  let walkAway: number;
  let target: number;
  if (typical !== null) {
    walkAway = asking !== null ? Math.min(asking, typical) : typical;
    // A live alternative for less is worth walking away to; one far cheaper is likely another thing.
    if (cheapest !== null && cheapest >= typical * 0.6) walkAway = Math.min(walkAway, cheapest);
    target = Math.min(walkAway, low ?? typical * 0.9);
  } else if (asking !== null) {
    basis = "No market reference: from the asking price alone";
    walkAway = asking;
    target = asking * 0.9;
  } else throw new PluginError(`Scout has no price for ${key} or anything like it.`);
  if (asking !== null) sources.unshift({ label: "Asking price", price: asking, url: listing.url });

  walkAway = roundPrice(walkAway, "down");
  target = Math.min(walkAway, roundPrice(target, "down"));
  const opening = Math.min(target, roundPrice(target * 0.85, "down"));

  const first = listing.history[0];
  const last = listing.history.at(-1);
  if (first && last && last.price < first.price)
    notes.push(
      `the price dropped from ${zl(first.price, listing.currency)} to ${zl(last.price, listing.currency)}`,
    );
  if (listing.listedAt) {
    const days = Math.floor((now.getTime() - Date.parse(listing.listedAt)) / 86_400_000);
    if (days >= 0) notes.push(`listed ${days} day${days === 1 ? "" : "s"} ago`);
  }
  if (listing.negotiable === false) notes.push("the seller marked the price as fixed");
  if (listing.negotiable === true) notes.push("the seller marked the price as negotiable");

  return {
    listing,
    appraisal: {
      currency: listing.currency,
      asking,
      opening,
      target,
      walkAway,
      basis: notes.length ? `${basis}; ${notes.join("; ")}.` : `${basis}.`,
      sources,
      at: now.toISOString(),
    },
  };
}

/** For the model: the walk-away price becomes the limit, which it isn't told. */
export function appraisalText(l: ListingFacts, a: Appraisal): string {
  const lines = [
    `${l.title} (${l.key}) ${l.url}`,
    `Asking ${a.asking !== null ? zl(a.asking, a.currency) : "unknown"}.`,
    `Open at ${zl(a.opening, a.currency)}, aim for ${zl(a.target, a.currency)}.`,
    `Basis: ${a.basis}`,
    "Rests on:",
    ...a.sources.map(
      (s) =>
        `- ${s.label}: ${s.price !== null ? zl(s.price, a.currency) : "?"}${s.url ? ` ${s.url}` : ""}`,
    ),
  ];
  return lines.join("\n");
}
