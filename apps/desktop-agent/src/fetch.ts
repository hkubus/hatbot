// POST /fetch, for watchers: a GET from the desktop, which reaches only the internet. The host firewall
// keeps it off the LAN, but not off the desktop itself (Chromium's DevTools on 127.0.0.1), so every hop
// of a redirect is checked here, and each request goes to the address that was checked: a name that
// resolves again to somewhere else (DNS rebinding) isn't looked up a second time.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { FetchResult } from "@hatbot/shared/desktop";

const MAX_REDIRECTS = 5;
/** Pages a watcher fetches are cut here. */
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

const v4 = (ip: string) => ip.split(".").reduce((n, p) => n * 256 + Number(p), 0);
const inV4 = (ip: string, net: string, len: number) =>
  Math.floor(v4(ip) / 2 ** (32 - len)) === Math.floor(v4(net) / 2 ** (32 - len));
const V4_BLOCKED: [string, number][] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 3],
];

/** An IPv6 address's eight 16-bit groups; `ip` must be one (isIP). */
function v6Groups(ip: string): number[] {
  let s = ip.toLowerCase().replace(/%.*$/, "");
  // A dotted IPv4 tail (::ffff:127.0.0.1) as its two groups.
  const tail = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (tail) {
    const n = v4(tail[2] as string);
    s = `${tail[1]}${Math.floor(n / 65536).toString(16)}:${(n % 65536).toString(16)}`;
  }
  const [head = "", rest] = s.split("::");
  const groups = (part: string) => (part ? part.split(":").map((g) => Number.parseInt(g, 16)) : []);
  const before = groups(head);
  const after = rest === undefined ? [] : groups(rest);
  return [...before, ...Array(8 - before.length - after.length).fill(0), ...after];
}

/**
 * Loopback, private, link-local and other addresses that aren't the internet, in any form: IPv4-mapped,
 * -compatible and -translated IPv6 (::ffff:7f00:1, ::127.0.0.1), NAT64, 6to4 and Teredo included. IPv6
 * passes only inside global unicast (2000::/3). Anything that isn't an address counts as private.
 */
export function privateAddress(ip: string): boolean {
  const kind = isIP(ip.replace(/%.*$/, ""));
  if (kind === 4) return V4_BLOCKED.some(([net, len]) => inV4(ip, net, len));
  if (kind !== 6) return true;
  const [g0 = 0, g1 = 0] = v6Groups(ip);
  return (
    (g0 & 0xe000) !== 0x2000 || // outside global unicast: ::/8 with its IPv4 forms, ULA, link-local, multicast
    (g0 === 0x2001 && g1 < 0x0200) || // IETF protocols, Teredo among them
    (g0 === 0x2001 && g1 === 0x0db8) || // documentation
    g0 === 0x2002 || // 6to4, which carries an IPv4 address
    (g0 === 0x3fff && g1 < 0x1000) // documentation
  );
}

/** Where `host` may be fetched from: its addresses when every one is on the internet, or why not. */
async function addressesOf(
  host: string,
  own: string[],
): Promise<{ addresses: string[] } | { refused: string }> {
  const bare = host.replace(/^\[|\]$/g, "");
  let addrs: string[];
  try {
    addrs = isIP(bare) ? [bare] : (await lookup(bare, { all: true })).map((a) => a.address);
  } catch {
    return { refused: `Couldn't find ${host}.` };
  }
  if (!addrs.length) return { refused: `Couldn't find ${host}.` };
  const bad = addrs.find((a) => privateAddress(a) || own.includes(a));
  if (bad)
    return { refused: `${host} is a local address (${bad}); only the internet can be fetched.` };
  return { addresses: addrs };
}

/** Refuses a host that is, or resolves to, an address off the internet or the desktop's own. */
export async function checkHost(host: string, own: string[]): Promise<string | null> {
  const r = await addressesOf(host, own);
  return "refused" in r ? r.refused : null;
}

/** The checked address to connect to for `host`, IPv4 first (the desktop has no IPv6 route). */
export async function resolveHost(host: string, own: string[]): Promise<string> {
  const r = await addressesOf(host, own);
  if ("refused" in r) throw new FetchError(r.refused, 400);
  return (r.addresses.find((a) => isIP(a) === 4) ?? r.addresses[0]) as string;
}

export type FetchOptions = {
  /** The desktop's own addresses. */
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
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new FetchError(`"${url}" isn't a URL.`, 400);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      throw new FetchError("Only http and https.", 400);
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
      body: (await readCapped(res)).slice(0, MAX_FETCH_CHARS),
    };
  }
}

/** The body as text, reading no more than MAX_FETCH_BYTES of it. */
export async function readCapped(res: Response): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    text += decoder.decode(value, { stream: true });
    if (bytes >= MAX_FETCH_BYTES || text.length >= MAX_FETCH_CHARS) {
      await reader.cancel();
      return text;
    }
  }
  return text + decoder.decode();
}
