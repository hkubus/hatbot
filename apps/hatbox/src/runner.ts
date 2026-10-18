// A box's backend (PLAN.md §21.6), run by hatbox@<id> as a user of its own, with no network and its own
// folder for data (the working directory, for bun:sqlite). It serves the box's built server.ts on a Unix
// socket the agent relays to, and its fetch goes to the agent, which lets through only box.json's hosts.
// What it prints is the box's log.
import { chmodSync, rmSync } from "node:fs";
import { join } from "node:path";

const sockets = process.env.HATBOX_SOCKETS ?? "";
const app = process.env.HATBOX_APP ?? "";
const direct = globalThis.fetch;
const egress = join(sockets, "egress.sock");

for (const level of ["log", "info", "warn", "error"] as const) {
  const write = console[level].bind(console);
  console[level] = (...args: unknown[]) => write(new Date().toISOString().slice(0, 19), ...args);
}

/** fetch, through the agent, which follows redirects itself and checks each. */
async function viaAgent(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const req =
    input instanceof Request ? new Request(input, init) : new Request(String(input), init);
  const headers = new Headers(req.headers);
  headers.set("x-hatbox-url", req.url);
  const res = await direct("http://egress/", {
    method: req.method,
    headers,
    body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer(),
    signal: req.signal,
    unix: egress,
  } as RequestInit);
  const refused = res.headers.get("x-hatbox-error");
  if (refused === null) return res;
  await res.body?.cancel();
  throw new TypeError(decodeURIComponent(refused));
}
globalThis.fetch = Object.assign(viaAgent, { preconnect: () => {} }) as typeof fetch;

type Backend = {
  fetch?: (req: Request) => Response | Promise<Response>;
  scheduled?: () => unknown;
};
const backend: Backend = (await import(app)).default ?? {};

const socket = join(sockets, "box.sock");
rmSync(socket, { force: true });
Bun.serve({
  unix: socket,
  maxRequestBodySize: 5 * 1024 * 1024 + 64 * 1024,
  async fetch(req) {
    // Only the agent reaches this socket, and it takes this header off what the page sends.
    if (req.headers.get("x-hatbox-op") === "scheduled") {
      if (typeof backend.scheduled !== "function")
        return new Response("server.ts has no scheduled().", { status: 404 });
      try {
        await backend.scheduled();
        return new Response(null, { status: 204 });
      } catch (err) {
        console.error("scheduled() failed:", err);
        return new Response(err instanceof Error ? err.message : String(err), { status: 500 });
      }
    }
    if (typeof backend.fetch !== "function")
      return new Response("server.ts has no fetch(req).", { status: 404 });
    return backend.fetch(req);
  },
  error(err) {
    console.error(err);
    return new Response(`The backend failed: ${err.message}`, { status: 500 });
  },
});
// The agent is another user.
chmodSync(socket, 0o666);
console.log("Started.");
