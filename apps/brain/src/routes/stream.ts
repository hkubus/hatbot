import { type Context, Hono } from "hono";
import { upgradeWebSocket } from "hono/bun";
import { principalOf } from "../auth/middleware";
import type { AppEnv } from "../context";

// One socket per client for live events (PLAN.md §8). Browsers authenticate with the session cookie,
// which needs an Origin check (cross-site WebSocket hijacking); apps send a bearer token.
export const streamRoutes = new Hono<AppEnv>().get(
  "/stream",
  async (c, next) => {
    const principal = principalOf(c);
    if (!principal) return c.json({ error: "unauthorized" }, 401);
    if (principal.kind === "session" && c.req.header("origin") !== c.var.config.publicUrl) {
      return c.json({ error: "bad origin" }, 403);
    }
    await next();
  },
  upgradeWebSocket((c) => {
    const { events, settings } = (c as Context<AppEnv>).var;
    let off: (() => void) | undefined;
    return {
      onOpen(_, ws) {
        ws.send(JSON.stringify({ type: "paused", paused: settings.get().paused }));
        off = events.on((e) => ws.send(JSON.stringify(e)));
      },
      onClose() {
        off?.();
      },
    };
  }),
);
