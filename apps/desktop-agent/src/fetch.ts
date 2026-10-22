// POST /fetch, for watchers: a GET from the desktop, which reaches only the internet. The host firewall
// keeps it off the LAN, but not off the desktop itself (Chromium's DevTools on 127.0.0.1), so every hop
// of a redirect is checked here, and each request goes to the address that was checked: a name that
// resolves again to somewhere else (DNS rebinding) isn't looked up a second time.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { FetchResult } from "@hatbot/shared/desktop";
import { privateAddress } from "@hatbot/shared/net";
import { readStream } from "./shell";

// The address check is shared with the boxes guest; render.ts takes it from here.
export { privateAddress };

const MAX_REDIRECTS = 5;
export const MAX_FETCH_CHARS = 2 * 1024 * 1024;
const MAX_FETCH_BYTES = 4 * MAX_FETCH_CHARS;
/** A desktop Chrome's: some sites turn away a script's, or headless Chromium's. */
export const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";
const HEADERS = {
  "user-agent": USER_AGENT,
  accept: "text/html,application/json;q=0.9,*/*;q=0.8",
  "accept-language": "en-GB,en;q=0.9",
};

export class FetchError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export function webUrl(target: string): URL {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    throw new FetchError(`"${target}" isn't a URL.`, 400);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new FetchError("Only http and https.", 400);
  return url;
}

/**
 * The address to connect to for `host`, IPv4 first (the desktop has no IPv6 route). It refuses a host
 * that is, or resolves to, an address off the internet or one of the desktop's own (`own`).
 */
export async function resolveHost(host: string, own: string[]): Promise<string> {
  const bare = host.replace(/^\[|\]$/g, "");
  let addrs: string[] = [];
  try {
    addrs = isIP(bare) ? [bare] : (await lookup(bare, { all: true })).map((a) => a.address);
  } catch {}
  if (!addrs.length) throw new FetchError(`Couldn't find ${host}.`, 400);
  const bad = addrs.find((a) => privateAddress(a) || own.includes(a));
  if (bad)
    throw new FetchError(
      `${host} is a local address (${bad}); only the internet can be fetched.`,
      400,
    );
  return (addrs.find((a) => isIP(a) === 4) ?? addrs[0]) as string;
}

export type FetchOptions = {
  own?: string[];
  /** The address a host is fetched from, or a FetchError saying why not; tests replace the DNS check. */
  resolve?: (host: string) => Promise<string>;
  timeoutMs?: number;
};

export async function fetchPage(target: string, opts: FetchOptions = {}): Promise<FetchResult> {
  const resolve = opts.resolve ?? ((host: string) => resolveHost(host, opts.own ?? []));
  const signal = AbortSignal.timeout(opts.timeoutMs ?? 20_000);
  let url = target;
  for (let hop = 0; ; hop++) {
    const parsed = webUrl(url);
    let address: string;
    try {
      address = await resolve(parsed.hostname);
    } catch (err) {
      if (err instanceof FetchError) throw new FetchError(err.message, hop ? 502 : 400);
      throw err;
    }
    // The checked address, with the name kept for the Host header and the certificate.
    const pinned = new URL(parsed.href);
    pinned.hostname = isIP(address) === 6 ? `[${address}]` : address;
    const named = !isIP(parsed.hostname.replace(/^\[|\]$/g, ""));
    let res: Response;
    try {
      res = await fetch(pinned.href, {
        redirect: "manual",
        signal,
        headers: { ...HEADERS, host: parsed.host },
        ...(named ? { tls: { serverName: parsed.hostname } } : {}),
      });
    } catch (err) {
      throw new FetchError(`Couldn't fetch it: ${(err as Error).message}`, 502);
    }
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      await res.body?.cancel();
      if (hop >= MAX_REDIRECTS) throw new FetchError(`More than ${MAX_REDIRECTS} redirects.`, 502);
      url = new URL(location, parsed).href;
      continue;
    }
    return {
      status: res.status,
      url: parsed.href,
      contentType: res.headers.get("content-type") ?? "",
      body: await readText(res.body),
    };
  }
}

/** A body as text, cut at MAX_FETCH_CHARS: no more than MAX_FETCH_BYTES of it is read. */
export async function readText(body: ReadableStream<Uint8Array> | null): Promise<string> {
  const { bytes, over } = await readStream(body, MAX_FETCH_BYTES);
  // A character cut off at the end is left out, not decoded as a broken one.
  return new TextDecoder().decode(bytes, { stream: over }).slice(0, MAX_FETCH_CHARS);
}
