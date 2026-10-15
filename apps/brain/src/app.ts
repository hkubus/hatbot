import { API_PREFIX, type Health } from "@hatbot/shared";
import { Hono } from "hono";
import { getConnInfo } from "hono/bun";
import type { AppEnv, Deps } from "./context";
import { adminRoutes } from "./routes/admin";
import { authRoutes } from "./routes/auth";
import { botRoutes } from "./routes/bots";
import { checkRoutes } from "./routes/checks";
import { desktopRoutes } from "./routes/desktop";
import { memoryRoutes } from "./routes/memory";
import { pluginRoutes } from "./routes/plugins";
import { hookRoutes, scheduleRoutes } from "./routes/schedules";
import { streamRoutes } from "./routes/stream";
import { approvalRoutes, taskRoutes } from "./routes/tasks";
import { teachRoutes } from "./routes/teach";
import { threadRoutes } from "./routes/thread";
import { watcherRoutes } from "./routes/watchers";

export const VERSION = "0.1.0";

export function createApp(deps: Deps) {
  const app = new Hono<AppEnv>().basePath(API_PREFIX);

  app.use(async (c, next) => {
    for (const [k, v] of Object.entries(deps)) c.set(k as keyof Deps, v as never);
    c.set("clientIp", clientIp(c, deps.config.trustedProxies));
    await next();
  });

  app.get("/health", (c) => c.json<Health>({ ok: true, version: VERSION }));
  app.route("/", authRoutes);
  app.route("/", threadRoutes);
  app.route("/", botRoutes);
  app.route("/", memoryRoutes);
  app.route("/", adminRoutes);
  app.route("/", streamRoutes);
  app.route("/", taskRoutes);
  app.route("/", approvalRoutes);
  app.route("/", desktopRoutes);
  app.route("/", scheduleRoutes);
  app.route("/", hookRoutes);
  app.route("/", pluginRoutes);
  app.route("/", teachRoutes);
  app.route("/", checkRoutes);
  app.route("/", watcherRoutes);

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
