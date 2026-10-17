import { afterAll, expect, test } from "bun:test";
import { FetchError, fetchPage, MAX_FETCH_CHARS, privateAddress, resolveHost } from "../src/fetch";

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const url = new URL(req.url);
    const n = Number(url.searchParams.get("n") ?? 0);
    if (url.pathname === "/hop")
      return n ? Response.redirect(`/hop?n=${n - 1}`, 302) : new Response("arrived");
    if (url.pathname === "/away") return Response.redirect("http://blocked.test/", 302);
    if (url.pathname === "/to") return Response.redirect(url.searchParams.get("u") ?? "/", 302);
    if (url.pathname === "/host") return new Response(req.headers.get("host"));
    if (url.pathname === "/big")
      return new Response(
        new ReadableStream({
          pull(c) {
            c.enqueue(new TextEncoder().encode("x".repeat(1024 * 1024)));
          },
        }),
      );
    return new Response("not found", { status: 404 });
  },
});
afterAll(() => server.stop(true));
const base = `http://127.0.0.1:${server.port}`;
// The test server is on loopback, which the real check refuses; this one refuses only blocked.test.
const resolve = async (host: string) => {
  if (host === "blocked.test") throw new FetchError("blocked", 400);
  return "127.0.0.1";
};
// The real check, except that public.test is a public name that happens to be served here.
const realExceptPublic = (host: string) =>
  host === "public.test" ? Promise.resolve("127.0.0.1") : resolveHost(host, []);

test("loopback, private and link-local addresses are refused, in every form", () => {
  for (const ip of [
    "127.0.0.1",
    "10.1.2.3",
    "192.168.55.225",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "192.0.2.10",
    "255.255.255.255",
  ])
    expect(privateAddress(ip)).toBe(true);
  for (const ip of [
    "::",
    "::1",
    "fe80::1",
    "fe80::1%eth0",
    "fd00::5",
    "fec0::1",
    "ff02::1",
    // IPv4-mapped, dotted and hex, and long-hand.
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::FFFF:7F00:0001",
    "0:0:0:0:0:ffff:7f00:1",
    "::ffff:a9fe:a9fe",
    "::ffff:c0a8:3701",
    // IPv4-compatible and -translated.
    "::127.0.0.1",
    "::7f00:1",
    "::ffff:0:7f00:1",
    // NAT64, 6to4, Teredo and documentation.
    "64:ff9b::7f00:1",
    "64:ff9b::127.0.0.1",
    "2002:7f00:1::1",
    "2001:0:4136:e378:8000:63bf:3fff:fdd2",
    "2001:db8::1",
    "3fff::1",
    // Not addresses at all.
    "2130706433",
    "0177.0.0.1",
    "localhost",
    "",
  ])
    expect(privateAddress(ip)).toBe(true);
  for (const ip of ["9.9.9.9", "1.1.1.1", "2a00:1450:4001::1", "2606:4700::1111"])
    expect(privateAddress(ip)).toBe(false);
});

test("the desktop itself can't be fetched, however its address is written", async () => {
  await expect(fetchPage(`${base}/hop`)).rejects.toBeInstanceOf(FetchError);
  for (const url of [
    "http://localhost:9222/json",
    "http://[::ffff:127.0.0.1]:9222/json/list",
    "http://[::ffff:7f00:1]:9222/json/list",
    "http://[0:0:0:0:0:ffff:7f00:1]:9222/",
    "http://[::127.0.0.1]:9222/",
    "http://[::7f00:1]:9222/",
    "http://[::1]:9222/",
    "http://[::]:9222/",
    "http://0.0.0.0:9222/",
    "http://2130706433:9222/",
    "http://0177.0.0.1:9222/",
    "http://0x7f.1:9222/",
    "http://127.1:9222/",
    "http://017700000001:9222/",
    "http://[64:ff9b::7f00:1]:9222/",
    "http://169.254.169.254/latest/meta-data/",
  ]) {
    const err = await fetchPage(url).catch((e) => e);
    expect(err).toBeInstanceOf(FetchError);
    expect([url, (err as FetchError).message]).toEqual([url, expect.stringContaining("local")]);
    expect((err as FetchError).status).toBe(400);
  }
});

test("a redirect to the desktop is refused, in every form", async () => {
  for (const to of [
    `http://[::ffff:127.0.0.1]:${server.port}/hop`,
    `http://[::ffff:7f00:1]:${server.port}/hop`,
    `http://[::127.0.0.1]:${server.port}/hop`,
    `http://0.0.0.0:${server.port}/hop`,
    `http://2130706433:${server.port}/hop`,
    `http://0177.0.0.1:${server.port}/hop`,
    `http://localhost:${server.port}/hop`,
  ]) {
    const err = await fetchPage(
      `http://public.test:${server.port}/to?u=${encodeURIComponent(to)}`,
      { resolve: realExceptPublic },
    ).catch((e) => e);
    expect(err).toBeInstanceOf(FetchError);
    expect([to, (err as FetchError).message]).toEqual([to, expect.stringContaining("local")]);
    expect((err as FetchError).status).toBe(502);
  }
});

test("the request goes to the address that was checked, not to a second lookup", async () => {
  // rebind.test isn't in DNS: only the checked address can have answered, with the name as the Host.
  const r = await fetchPage(`http://rebind.test:${server.port}/host`, { resolve });
  expect(r.body).toBe(`rebind.test:${server.port}`);
  expect(r.url).toBe(`http://rebind.test:${server.port}/host`);
});

test("redirects are followed up to five, each hop checked", async () => {
  const r = await fetchPage(`${base}/hop?n=5`, { resolve });
  expect(r.body).toBe("arrived");
  expect(r.url).toBe(`${base}/hop?n=0`);
  await expect(fetchPage(`${base}/hop?n=6`, { resolve })).rejects.toThrow("redirects");
  await expect(fetchPage(`${base}/away`, { resolve })).rejects.toThrow("blocked");
});

test("a body that doesn't end is cut at the limit", async () => {
  const r = await fetchPage(`${base}/big`, { resolve });
  expect(r.body.length).toBe(MAX_FETCH_CHARS);
});
