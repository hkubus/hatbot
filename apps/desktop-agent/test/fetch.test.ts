import { afterAll, expect, test } from "bun:test";
import { type FetchError, fetchPage, privateAddress, resolveHost } from "../src/fetch";

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const url = new URL(req.url);
    const n = Number(url.searchParams.get("n") ?? 0);
    if (url.pathname === "/hop")
      return n ? Response.redirect(`/hop?n=${n - 1}`, 302) : new Response("arrived");
    if (url.pathname === "/to") return Response.redirect(url.searchParams.get("u") ?? "/", 302);
    if (url.pathname === "/host") return new Response(req.headers.get("host"));
    return new Response("not found", { status: 404 });
  },
});
afterAll(() => server.stop(true));
// The test server is on loopback, which the real check refuses: names under .test reach it, and
// everything else is checked for real.
const resolve = (host: string) =>
  host.endsWith(".test") ? Promise.resolve("127.0.0.1") : resolveHost(host, []);
const site = `http://public.test:${server.port}`;

test("loopback, private and link-local addresses are refused in every form; the internet isn't", () => {
  for (const ip of [
    "127.0.0.1",
    // IPv4-mapped (dotted and hex), -compatible and NAT64 forms of loopback.
    ...["::ffff:127.0.0.1", "::ffff:7f00:1", "::127.0.0.1", "64:ff9b::7f00:1"],
    // 6to4 and Teredo, which carry an IPv4 address, and link-local with a zone id.
    ...["2002:7f00:1::1", "2001:0:4136:e378:8000:63bf:3fff:fdd2", "fe80::1%eth0"],
    "localhost",
  ])
    expect([ip, privateAddress(ip)]).toEqual([ip, true]);
  for (const ip of ["1.1.1.1", "2606:4700::1111"])
    expect([ip, privateAddress(ip)]).toEqual([ip, false]);
});

test("the request goes to the address that was checked, not to a second lookup", async () => {
  // rebind.test isn't in DNS: only the checked address can have answered, with the name as the Host.
  const r = await fetchPage(`http://rebind.test:${server.port}/host`, { resolve });
  expect(r.body).toBe(`rebind.test:${server.port}`);
});

test("every hop is checked: the desktop is refused as the address or a redirect's", async () => {
  const refused = (url: string) =>
    fetchPage(url, { resolve }).catch((e: FetchError) => [e.status, e.message]);
  const local = expect.stringContaining("local address");
  expect(await refused("http://[::ffff:7f00:1]:9222/json/list")).toEqual([400, local]);
  const desktop = encodeURIComponent(`http://[::1]:${server.port}/hop`);
  expect(await refused(`${site}/to?u=${desktop}`)).toEqual([502, local]);
  // Up to five redirects are followed.
  expect((await fetchPage(`${site}/hop?n=5`, { resolve })).body).toBe("arrived");
  await expect(fetchPage(`${site}/hop?n=6`, { resolve })).rejects.toThrow("redirects");
});
