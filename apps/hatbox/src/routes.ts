// The agent's HTTP side, for the brain only (PLAN.md §21.6). A request about a box says which version
// of it the brain means (x-hatbox-version); one the guest hasn't built is answered 409 with `missing`,
// and the brain sends it again.
import { timingSafeEqual } from "node:crypto";
import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BoxFile, HatboxStatus } from "@hatbot/shared/hatbox";
import { readUpTo } from "./files";
import { type Guest, GuestError } from "./guest";

export const MAX_UPDATE_BYTES = 10 * 1024 * 1024;
/** A box's files, as JSON: 2 MB of source, escaped. */
const MAX_PUT_BYTES = 6 * 1024 * 1024;
const FEATURES: string[] = [];

const json = (body: unknown, status = 200) => Response.json(body, { status });
const versionOf = (req: Request) => Number(req.headers.get("x-hatbox-version")) || 0;

export function routes(
  guest: Guest,
  o: {
    token: string;
    version?: string /** Where an update is dropped, when they're on. */;
    updates?: string;
  },
) {
  const want = Buffer.from(`Bearer ${o.token}`);
  const authorized = (req: Request) => {
    const got = Buffer.from(req.headers.get("authorization") ?? "");
    return got.length === want.length && timingSafeEqual(got, want);
  };

  async function handle(req: Request, url: URL): Promise<Response> {
    const route = `${req.method} ${url.pathname}`;
    if (route === "GET /health")
      return json({ ok: true, version: o.version, features: FEATURES } satisfies HatboxStatus);
    if (route === "GET /boxes") return json(guest.list());
    if (route === "POST /update") {
      // A new copy of this app from the brain's updater; hatbox-agent-update.path installs it as root.
      if (!o.updates) return json({ error: "updates aren't enabled" }, 501);
      const bytes = await readUpTo(req, MAX_UPDATE_BYTES);
      if (!bytes?.length)
        return json({ error: "expected a tar archive under 10 MB" }, bytes ? 400 : 413);
      const tmp = join(o.updates, "update.tar.part");
      writeFileSync(tmp, bytes, { mode: 0o600 });
      renameSync(tmp, join(o.updates, "update.tar"));
      return json({ ok: true }, 202);
    }
    const m = url.pathname.match(/^\/boxes\/([1-9]\d{0,9})(\/.*)?$/);
    if (!m) return json({ error: "not found" }, 404);
    const id = Number(m[1]);
    const rest = m[2] ?? "";
    if (rest === "/http" || rest.startsWith("/http/"))
      return guest.http(id, versionOf(req), req, `${rest.slice(5) || "/"}${url.search}`);
    switch (`${req.method} ${rest}`) {
      case "PUT ": {
        const bytes = await readUpTo(req, MAX_PUT_BYTES);
        if (!bytes) return json({ error: "A box's files are at most 2 MB." }, 413);
        let files: unknown;
        try {
          files = (JSON.parse(new TextDecoder().decode(bytes)) as { files?: unknown }).files;
        } catch {}
        if (!Array.isArray(files)) return json({ error: "expected { files }" }, 400);
        guest.put(id, versionOf(req), files as BoxFile[]);
        return new Response(null, { status: 204 });
      }
      case "POST /build":
        return json(await guest.build(id, versionOf(req)));
      case "POST /scheduled": {
        const error = await guest.scheduled(id, versionOf(req));
        return json(error === null ? { ok: true } : { ok: false, error });
      }
      case "GET /logs":
        return new Response(guest.logs(id), {
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      case "POST /stop":
        await guest.stop(id);
        return json({ ok: true });
      case "DELETE ":
        await guest.remove(id);
        return json({ ok: true });
    }
    return json({ error: "not found" }, 404);
  }

  return async (req: Request): Promise<Response> => {
    if (!authorized(req)) return json({ error: "unauthorized" }, 401);
    try {
      return await handle(req, new URL(req.url));
    } catch (err) {
      if (err instanceof GuestError)
        return json({ error: err.message, missing: err.missing || undefined }, err.status);
      console.error(err);
      return json({ error: (err as Error).message }, 500);
    }
  };
}
