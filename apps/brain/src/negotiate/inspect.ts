// A listing as a buyer looks at it before choosing: Scout's record, then the live page and its photos,
// fetched from the desktop, which reaches only the internet.
import type { DesktopAgent } from "../desktop/client";
import { PluginError, type PluginTool, type ToolImage, type ToolOutput } from "../plugins/plugin";
import { decodeEntities } from "../watch/extract";
import { factsFrom, readScout, scoutTool } from "./appraise";
import { zl } from "./policy";

export const MAX_PHOTOS = 5;
const MAX_PAGE_TEXT = 6000;
const SKIPPED = "head, script, style, noscript, template, svg, header, nav, footer";
const BLOCKS = "p, div, li, h1, h2, h3, h4, h5, h6, dt, dd, tr, section, article, br";

/** Only the marketplaces' own photos: a page's ads and badges come from elsewhere. */
function photoOf(raw: string): { key: string; url: string; rank: number } | null {
  let u: URL;
  try {
    u = new URL(decodeEntities(raw));
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  const host = u.hostname;
  if (host.endsWith(".olxcdn.com")) {
    const m = u.pathname.match(/^(\/v1\/files\/[^/;]+\/image)/);
    // Asked for at a size the model reads well, not the camera's original.
    return m ? { key: `${host}${m[1]}`, url: `https://${host}${m[1]};s=1000x0`, rank: 0 } : null;
  }
  if (host === "a.allegroimg.com") {
    const m = u.pathname.match(/^\/[^/]+\/([0-9a-f]+\/[0-9a-f]+)$/);
    return m ? { key: `${host}/${m[1]}`, url: `https://${host}/s720/${m[1]}`, rank: 0 } : null;
  }
  if (/^images\d*\.vinted\.net$/.test(host)) {
    // Vinted signs each size's address, so it's kept as it was found, the largest seen.
    const m = u.pathname.match(/^\/t\/([^/]+)\/([^/]+)\//);
    if (!m) return null;
    const size = m[2] === "f800" ? 800 : Number(m[2]?.split("x")[0]) || 0;
    return { key: `vinted/${m[1]}`, url: u.href, rank: -size };
  }
  return null;
}

/** The listing's photos first: its structured data, then the page's own order, where its gallery leads. */
export function photosIn(html: string, first: string[] = []): string[] {
  const found = new Map<string, { url: string; rank: number; at: number }>();
  const add = (raw: string) => {
    const p = photoOf(raw);
    if (!p) return;
    const seen = found.get(p.key);
    if (!seen) found.set(p.key, { url: p.url, rank: p.rank, at: found.size });
    else if (p.rank < seen.rank) found.set(p.key, { ...seen, url: p.url, rank: p.rank });
  };
  first.forEach(add);
  for (const m of html.matchAll(/https:\/\/[^\s"'<>\\)]+/g)) add(m[0]);
  return [...found.values()].sort((a, b) => a.at - b.at).map((p) => p.url);
}

/** What a visitor reads on the page, a line to each block, without its menus and scripts. */
export async function listingText(html: string): Promise<string> {
  const out: string[] = [];
  let skip = 0;
  await new HTMLRewriter()
    .on(SKIPPED, {
      element(el) {
        if (!el.canHaveContent) return;
        skip++;
        el.onEndTag(() => {
          skip--;
        });
      },
    })
    .on(BLOCKS, {
      element(el) {
        out.push("\n");
        if (el.canHaveContent)
          el.onEndTag(() => {
            out.push("\n");
          });
      },
    })
    .on("*", {
      element() {
        out.push(" ");
      },
    })
    .onDocument({
      text(t) {
        if (!skip) out.push(t.text);
      },
    })
    .transform(new Response(html))
    .text();
  const lines = decodeEntities(out.join(""))
    .replace(/\p{Cf}/gu, "")
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l, i, all) => l && l !== all[i - 1]);
  const text = lines.join("\n");
  return text.length > MAX_PAGE_TEXT ? `${text.slice(0, MAX_PAGE_TEXT)}\n…` : text;
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const urls = (v: unknown): string[] =>
  (Array.isArray(v) ? v : [v]).flatMap((x) => str(x) ?? str(obj(x).url) ?? []);

export async function inspect(
  tools: PluginTool[],
  desktop: DesktopAgent | null,
  key: string,
  signal: AbortSignal,
): Promise<ToolOutput> {
  const detail = scoutTool(tools, "scout_listing_detail");
  if (!detail)
    throw new PluginError("Scout isn't connected: connect it in Settings → Plugins → Scout.");
  const d = await readScout(detail, { key }, signal);
  const l = factsFrom(key, d);
  const listing = obj(d.listing);
  const snapshot = obj(d.descriptionSnapshot);
  const lines = [
    `${l.title} (${l.key}) ${l.url}`,
    `Asking ${l.asking !== null ? zl(l.asking, l.currency) : "unknown"}${l.typical ? `; Scout's typical price ${zl(l.typical, l.currency)}` : ""}.`,
  ];
  const condition = str(listing.condition) ?? str(snapshot.condition);
  const location = str(listing.location) ?? str(snapshot.location);
  if (condition) lines.push(`Condition: ${condition}`);
  if (location) lines.push(`Location: ${location}`);
  const scoutPhotos = [
    ...urls(d.photos),
    ...urls(d.images),
    ...urls(listing.image),
    ...urls(listing.imageUrl),
  ];

  let page = "";
  let photos = scoutPhotos;
  let why: string | null = null;
  if (!desktop?.configured) why = "the desktop isn't set up, so the page wasn't read";
  else {
    try {
      const r = await desktop.fetch(l.url);
      if (r.status >= 400) why = `the listing's page answered ${r.status}; it may be gone`;
      else {
        page = await listingText(r.body);
        const data = [...r.body.matchAll(/<script[^>]*ld\+json[^>]*>([\s\S]*?)<\/script>/gi)]
          .flatMap((m) => {
            try {
              return [JSON.parse(m[1] ?? "")];
            } catch {
              return [];
            }
          })
          .flat()
          .map(obj);
        const product = data.find((x) => x["@type"] === "Product");
        photos = photosIn(r.body, [...urls(product?.image), ...scoutPhotos]);
      }
    } catch (err) {
      why = `the listing's page couldn't be read: ${(err as Error).message}`;
    }
  }
  if (page) lines.push("", "The listing's page as it is now:", page);
  else {
    const description = str(snapshot.description);
    if (description) lines.push("", "The description as Scout last saw it:", description);
  }

  const images: ToolImage[] = [];
  let failed: string | null = null;
  if (desktop?.configured) {
    const got = await Promise.all(
      photos.slice(0, MAX_PHOTOS).map((url) =>
        desktop.fetchImage(url).catch((err: Error) => {
          failed ??= err.message;
          return null;
        }),
      ),
    );
    for (const g of got) if (g) images.push(g);
  }
  lines.push(
    "",
    photos.length
      ? `Photos: ${images.length ? `the first ${images.length} of ${photos.length}, below` : `${photos.length}, but none could be fetched${failed ? ` (${failed})` : ""}`}.`
      : "No photos found.",
  );
  if (why) lines.push(`Note: ${why}.`);
  return { text: lines.join("\n"), images };
}
