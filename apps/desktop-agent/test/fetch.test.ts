import { afterAll, expect, test } from "bun:test";
import { FetchError, fetchPage, MAX_FETCH_CHARS, privateAddress } from "../src/fetch";

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const url = new URL(req.url);
    const n = Number(url.searchParams.get("n") ?? 0);
    if (url.pathname === "/hop")
      return n ? Response.redirect(`/hop?n=${n - 1}`, 302) : new Response("arrived");
    if (url.pathname === "/away") return Response.redirect("http://blocked.test/", 302);
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
const check = async (host: string) => (host === "blocked.test" ? "blocked" : null);

test("loopback, private and link-local addresses are refused", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "192.168.55.225", "169.254.169.254", "100.64.0.1"])
    expect(privateAddress(ip)).toBe(true);
  for (const ip of ["::1", "fe80::1", "fd00::5", "::ffff:127.0.0.1"])
    expect(privateAddress(ip)).toBe(true);
  for (const ip of ["9.9.9.9", "1.1.1.1", "2a00:1450::1"]) expect(privateAddress(ip)).toBe(false);
});

test("the desktop itself can't be fetched", async () => {
  await expect(fetchPage(`${base}/hop`)).rejects.toBeInstanceOf(FetchError);
  await expect(fetchPage("http://localhost:9222/json")).rejects.toThrow("local address");
});

test("redirects are followed up to five, each hop checked", async () => {
  const r = await fetchPage(`${base}/hop?n=5`, { check });
  expect(r.body).toBe("arrived");
  expect(r.url).toBe(`${base}/hop?n=0`);
  await expect(fetchPage(`${base}/hop?n=6`, { check })).rejects.toThrow("redirects");
  await expect(fetchPage(`${base}/away`, { check })).rejects.toThrow("blocked");
});

test("a body that doesn't end is cut at the limit", async () => {
  const r = await fetchPage(`${base}/big`, { check });
  expect(r.body.length).toBe(MAX_FETCH_CHARS);
});
