// POST /fetch, for watchers: a GET from the desktop, which reaches only the internet. The host firewall
// keeps it off the LAN, but not off the desktop itself (Chromium's DevTools on 127.0.0.1), so every hop
// of a redirect is checked here.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { FetchResult } from "@hatbot/shared/desktop";

const MAX_REDIRECTS = 5;
/** Pages a watcher fetches are cut here. */
export const MAX_FETCH_CHARS = 2 * 1024 * 1024;
const MAX_FETCH_BYTES = 4 * MAX_FETCH_CHARS;
const HEADERS = {
  "user-agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36",
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
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 3],
];

/** Loopback, private, link-local and other addresses that aren't the internet. */
export function privateAddress(ip: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)?.[1];
  if (mapped) return privateAddress(mapped);
  if (isIP(ip) === 4) return V4_BLOCKED.some(([net, len]) => inV4(ip, net, len));
  const low = ip.toLowerCase();
  return (
    low === "::" ||
    low === "::1" ||
    /^f[cd]/.test(low) || // unique local
    /^fe[89ab]/.test(low) || // link-local
    /^ff/.test(low) // multicast
  );
}

/** Refuses a host that is, or resolves to, an address off the internet or the desktop's own. */
async function defaultCheck(host: string, own: string[]): Promise<string | null> {
  const bare = host.replace(/^\[|\]$/g, "");
  let addrs: string[];
  try {
    addrs = isIP(bare) ? [bare] : (await lookup(bare, { all: true })).map((a) => a.address);
  } catch {
    return `Couldn't find ${host}.`;
  }
  const bad = addrs.find((a) => privateAddress(a) || own.includes(a));
  return bad ? `${host} is a local address (${bad}); only the internet can be fetched.` : null;
}

export type FetchOptions = {
  /** The desktop's own addresses. */
  own?: string[];
  /** Says why a host may not be fetched, or null; tests replace the DNS check. */
  check?: (host: string) => Promise<string | null>;
  timeoutMs?: number;
};

export async function fetchPage(target: string, opts: FetchOptions = {}): Promise<FetchResult> {
  const check = opts.check ?? ((host: string) => defaultCheck(host, opts.own ?? []));
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
    const refused = await check(parsed.hostname);
    if (refused) throw new FetchError(refused, hop ? 502 : 400);
    let res: Response;
    try {
      res = await fetch(parsed.href, { redirect: "manual", signal, headers: HEADERS });
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
async function readCapped(res: Response): Promise<string> {
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
