// Listing photos for listings blocks. The page loads only Hatbot's own pictures (web.ts), so the
// brain fetches them, from the marketplaces' image servers only (listingPhoto).
import { listingPhoto } from "@hatbot/shared";

const TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"];
const MAX_BYTES = 5 << 20;
const KEPT_BYTES = 40 << 20;
const REDIRECTS = 3;

export type Photo = { bytes: Uint8Array; type: string };
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export class ListingPhotos {
  private kept = new Map<string, Photo>();
  private keptBytes = 0;
  private loading = new Map<string, Promise<Photo | null>>();

  constructor(private fetch: Fetch = globalThis.fetch) {}

  /** The photo, or null if it isn't a marketplace's or didn't load. */
  get(url: string): Promise<Photo | null> {
    const hit = this.kept.get(url);
    if (hit) {
      this.kept.delete(url);
      this.kept.set(url, hit);
      return Promise.resolve(hit);
    }
    let p = this.loading.get(url);
    if (!p) {
      p = this.load(url).finally(() => this.loading.delete(url));
      this.loading.set(url, p);
    }
    return p;
  }

  private async load(url: string): Promise<Photo | null> {
    let at = url;
    for (let hop = 0; hop <= REDIRECTS; hop++) {
      if (!listingPhoto(at)) return null;
      const res = await this.fetch(at, {
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
        headers: { accept: TYPES.join(",") },
      }).catch(() => null);
      if (!res) return null;
      const next = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && next) {
        await res.body?.cancel();
        if (!URL.canParse(next, at)) return null;
        at = new URL(next, at).toString();
        continue;
      }
      const type = res.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
      if (
        !res.ok ||
        !TYPES.includes(type) ||
        Number(res.headers.get("content-length")) > MAX_BYTES
      ) {
        await res.body?.cancel();
        return null;
      }
      const bytes = await capped(res, MAX_BYTES);
      if (!bytes) return null;
      const photo = { bytes, type };
      this.keep(url, photo);
      return photo;
    }
    return null;
  }

  private keep(url: string, photo: Photo) {
    this.kept.set(url, photo);
    this.keptBytes += photo.bytes.length;
    for (const [k, v] of this.kept) {
      if (this.keptBytes <= KEPT_BYTES) break;
      this.kept.delete(k);
      this.keptBytes -= v.bytes.length;
    }
  }
}

async function capped(res: Response, max: number): Promise<Uint8Array | null> {
  const reader = res.body?.getReader();
  if (!reader) return null;
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > max) {
        await reader.cancel();
        return null;
      }
      parts.push(value);
    }
  } catch {
    return null;
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
