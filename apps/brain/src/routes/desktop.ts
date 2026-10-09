import type { LiveInput } from "@hatbot/shared/desktop";
import { type Context, Hono } from "hono";
import { upgradeWebSocket } from "hono/bun";
import { principalOf, requireAuth } from "../auth/middleware";
import type { AppEnv } from "../context";

const LIVE_INPUT = new Set(["move", "button", "wheel", "key"]);

function validInput(m: unknown): m is LiveInput {
  if (!m || typeof m !== "object") return false;
  const o = m as Record<string, unknown>;
  if (!LIVE_INPUT.has(o.t as string)) return false;
  if (o.t === "key")
    return typeof o.key === "string" && o.key.length <= 32 && typeof o.down === "boolean";
  return typeof o.x === "number" && typeof o.y === "number";
}

export const desktopRoutes = new Hono<AppEnv>()
  .get(
    "/desktop/live",
    // Same rules as /stream: a cookie needs the public Origin, an app uses its bearer token.
    async (c, next) => {
      const principal = principalOf(c);
      if (!principal) return c.json({ error: "unauthorized" }, 401);
      if (principal.kind === "session" && c.req.header("origin") !== c.var.config.publicUrl) {
        return c.json({ error: "bad origin" }, 403);
      }
      if (!c.var.desktop.agent.configured)
        return c.json({ error: "the desktop isn't set up" }, 503);
      await next();
    },
    // The live view (PLAN.md §10.5): JPEG frames from desktop-agent out, your input in while you have control.
    upgradeWebSocket((c) => {
      const { desktop } = (c as Context<AppEnv>).var;
      let upstream: WebSocket | null = null;
      return {
        onOpen(_, ws) {
          const { url, headers } = desktop.agent.liveSocket();
          upstream = new WebSocket(url, { headers } as unknown as string[]);
          upstream.binaryType = "arraybuffer";
          upstream.onmessage = (e) => ws.send(e.data as ArrayBuffer);
          upstream.onclose = () => ws.close(1011, "desktop disconnected");
          upstream.onerror = () => ws.close(1011, "desktop unreachable");
        },
        onMessage(e) {
          if (typeof e.data !== "string" || desktop.get().control !== "owner") return;
          let m: unknown;
          try {
            m = JSON.parse(e.data);
          } catch {
            return;
          }
          if (validInput(m) && upstream?.readyState === WebSocket.OPEN)
            upstream.send(JSON.stringify(m));
        },
        onClose() {
          upstream?.close();
        },
      };
    }),
  )
  .use("/desktop/*", requireAuth)
  .get("/desktop/status", (c) => c.json(c.var.desktop.get()))
  .post("/desktop/takeover", async (c) => {
    try {
      await c.var.desktop.takeover();
    } catch {
      return c.json({ error: "The desktop isn't answering." }, 503);
    }
    return c.json(c.var.desktop.get());
  })
  .post("/desktop/handback", async (c) => {
    try {
      await c.var.desktop.handback();
    } catch {
      return c.json({ error: "The desktop isn't answering." }, 503);
    }
    return c.json(c.var.desktop.get());
  });
