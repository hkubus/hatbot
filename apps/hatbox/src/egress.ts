// A box's fetch (PLAN.md §21.1, Egress): its backend has no network, so its requests come to the agent,
// which sends on only those to the hosts in its box.json, and only to the internet, as desktop-agent's
// /fetch does: every hop of a redirect is checked, and each request goes to the address that was
// checked, so a name that resolves again to somewhere else (DNS rebinding) isn't looked up twice.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { MAX_BOX_BODY, passedHeaders } from "@hatbot/shared/hatbox";
import { privateAddress } from "@hatbot/shared/net";
import { readStream } from "./files";

const MAX_REDIRECTS = 5;

/** Why a box's request wasn't sent, for the box and its log. */
export class EgressError extends Error {}

const addresses = async (host: string) => (await lookup(host, { all: true })).map((a) => a.address);

/** The address to connect to for `host`, IPv4 first; one off the internet is refused. */
export async function publicAddress(host: string, find = addresses): Promise<string> {
  let addrs: string[] = [];
  try {
    addrs = isIP(host) ? [host] : await find(host);
  } catch {}
  if (!addrs.length) throw new EgressError(`Couldn't find ${host}.`);
  const bad = addrs.find((a) => privateAddress(a));
  if (bad)
    throw new EgressError(`${host} is a local address (${bad}); boxes reach only the internet.`);
  return (addrs.find((a) => isIP(a) === 4) ?? addrs[0]) as string;
}

export type EgressOptions = {
  /** The hosts in the box's box.json. */
  hosts: string[];
  /** The address a host is reached at; tests stand in for the DNS check. */
  resolve?: (host: string) => Promise<string>;
  timeoutMs?: number;
};

/** The box's request (its address in x-hatbox-url) sent on, or an EgressError saying why not. */
export async function sendOn(req: Request, opts: EgressOptions): Promise<Response> {
  const resolve = opts.resolve ?? publicAddress;
  const signal = AbortSignal.timeout(opts.timeoutMs ?? 30_000);
  const { bytes: sent, over } = await readStream(req.body, MAX_BOX_BODY);
  if (over) throw new EgressError("A box sends at most 5 MB in a request.");
  let method = req.method;
  let body: Uint8Array | undefined = method === "GET" || method === "HEAD" ? undefined : sent;
  const headers = passedHeaders(req.headers);
  let target = req.headers.get("x-hatbox-url") ?? "";
  for (let hop = 0; ; hop++) {
    let url: URL;
    try {
      url = new URL(target);
    } catch {
      throw new EgressError(`"${target}" isn't a URL.`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:")
      throw new EgressError(`${url.protocol} isn't allowed: only http and https.`);
    const host = url.hostname.toLowerCase();
    if (!opts.hosts.includes(host))
      throw new EgressError(
        `${host} isn't in box.json's hosts${hop ? " (a redirect went there)" : ""}.`,
      );
    const address = await resolve(host);
    // The checked address, with the name kept for the Host header and the certificate.
    const pinned = new URL(url.href);
    pinned.hostname = isIP(address) === 6 ? `[${address}]` : address;
    let res: Response;
    try {
      res = await fetch(pinned.href, {
        method,
        body,
        redirect: "manual",
        signal,
        headers: [...headers, ["host", url.host]],
        tls: { serverName: host },
      } as RequestInit);
    } catch (err) {
      throw new EgressError(`Couldn't reach ${host}: ${(err as Error).message}`);
    }
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      await res.body?.cancel();
      if (hop >= MAX_REDIRECTS) throw new EgressError(`More than ${MAX_REDIRECTS} redirects.`);
      target = new URL(location, url).href;
      // As browsers do: only 307 and 308 send the same request again.
      if (res.status !== 307 && res.status !== 308) {
        method = method === "HEAD" ? "HEAD" : "GET";
        body = undefined;
      }
      continue;
    }
    const { bytes, over } = await readStream(res.body, MAX_BOX_BODY);
    if (over) throw new EgressError(`${host}'s answer is over 5 MB.`);
    const out = new Headers(passedHeaders(res.headers));
    out.set("x-hatbox-url", url.href);
    return new Response(nullBody(res.status) ? null : bytes, { status: res.status, headers: out });
  }
}

/** Statuses a Response can't have a body with. */
export const nullBody = (status: number) => [101, 204, 205, 304].includes(status);
