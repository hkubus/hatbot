import { API_PREFIX, type Health } from "@hatbot/shared";
import { Hono } from "hono";
import { getConnInfo } from "hono/bun";
import type { AppEnv, Deps } from "./context";
import { authRoutes } from "./routes/auth";

export const VERSION = "0.0.0";

export function createApp(deps: Deps) {
  const app = new Hono<AppEnv>().basePath(API_PREFIX);

  app.use(async (c, next) => {
    for (const [k, v] of Object.entries(deps)) c.set(k as keyof Deps, v as never);
    c.set("clientIp", clientIp(c, deps.config.trustedProxies));
    await next();
  });

  app.get("/health", (c) => c.json<Health>({ ok: true, version: VERSION }));
  app.route("/", authRoutes);

  app.notFound((c) => c.json({ error: "not found" }, 404));
  app.onError((err, c) => {
    console.error(err);
    return c.json({ error: "internal error" }, 500);
  });
  return app;
}

// The socket peer, or the client your reverse proxy reports if the peer is the proxy.
function clientIp(c: Parameters<typeof getConnInfo>[0], trusted: string[]): string {
  let peer = "unknown";
  try {
    peer = getConnInfo(c).remote.address ?? "unknown";
  } catch {
    // app.request() in tests has no socket.
  }
  peer = peer.replace(/^::ffff:/, "");
  if (trusted.includes(peer)) {
    const forwarded = c.req.header("x-forwarded-for")?.split(",").at(-1)?.trim();
    if (forwarded) return forwarded;
  }
  return peer;
}
