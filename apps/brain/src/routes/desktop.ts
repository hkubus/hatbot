import type { LiveInput } from "@hatbot/shared/desktop";
import { type Context, Hono } from "hono";
import { upgradeWebSocket } from "hono/bun";
import { z } from "zod";
import { principalOf, requireAuth } from "../auth/middleware";
import type { AppEnv } from "../context";
import { DesktopBusy } from "../desktop/service";
import { ProxmoxError } from "../proxmox";
import { json } from "./util";

/** Holds the screen lane while the desktop rolls back, so no task starts on it. */
const ROLLBACK = -1;
/** A viewer that falls this far behind skips frames instead of seeing the desktop late. */
const LIVE_BUFFER_BYTES = 512 * 1024;

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
      const { desktop, teach } = (c as Context<AppEnv>).var;
      let upstream: WebSocket | null = null;
      let behind: ArrayBuffer | null = null;
      let waiting: ReturnType<typeof setTimeout> | undefined;
      return {
        onOpen(_, ws) {
          const { url, headers } = desktop.agent.liveSocket();
          const raw = ws.raw as { getBufferedAmount?: () => number } | undefined;
          // On a slow connection, skip frames rather than fall behind the desktop. The newest goes out
          // once the viewer catches up: a desktop that has gone still sends nothing more.
          const flush = () => {
            waiting = undefined;
            if (!behind) return;
            if ((raw?.getBufferedAmount?.() ?? 0) < LIVE_BUFFER_BYTES) {
              ws.send(behind);
              behind = null;
            } else waiting = setTimeout(flush, 100);
          };
          upstream = new WebSocket(url, { headers } as unknown as string[]);
          upstream.binaryType = "arraybuffer";
          upstream.onmessage = (e) => {
            behind = e.data as ArrayBuffer;
            if (!waiting) flush();
          };
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
          if (validInput(m) && upstream?.readyState === WebSocket.OPEN) {
            upstream.send(JSON.stringify(m));
            teach.input(m);
          }
        },
        onClose() {
          clearTimeout(waiting);
          upstream?.close();
        },
      };
    }),
  )
  .use("/desktop/*", requireAuth)
  .get("/desktop/status", (c) => c.json(c.var.desktop.get()))
  .post("/desktop/takeover", async (c) => {
    try {
      await c.var.desktop.takeover(true);
    } catch (err) {
      if (err instanceof DesktopBusy) return c.json({ error: err.message }, 409);
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
  })
  .get("/desktop/snapshots", async (c) => {
    const { proxmox } = c.var;
    if (!proxmox.configured) return c.json({ configured: false, snapshots: [] });
    try {
      return c.json({ configured: true, snapshots: await proxmox.desktopSnapshots() });
    } catch (err) {
      return c.json({ error: err instanceof ProxmoxError ? err.message : "Proxmox failed" }, 502);
    }
  })
  // "Roll back desktop" in Settings (PLAN.md §8): back to a nightly snapshot, then started again.
  .post("/desktop/rollback", json(z.object({ name: z.string().min(1).max(40) })), async (c) => {
    const { proxmox, tasks, desktop } = c.var;
    if (!proxmox.configured) return c.json({ error: "Proxmox isn't set up." }, 503);
    if (tasks.lane.holderId === ROLLBACK) return c.json({ error: "Already rolling back." }, 409);
    if (tasks.list({ status: "active" }).some((t) => t.lane === "screen"))
      return c.json({ error: "A task is using the desktop. Cancel it first." }, 409);
    if (desktop.get().control === "owner")
      return c.json({ error: "Hand the desktop back first." }, 409);
    await tasks.lane.acquire(ROLLBACK, new AbortController().signal);
    try {
      await proxmox.rollbackDesktop(c.req.valid("json").name);
    } catch (err) {
      const status = err instanceof ProxmoxError && err.status === 400 ? 400 : 502;
      return c.json(
        { error: err instanceof ProxmoxError ? err.message : "Rollback failed" },
        status,
      );
    } finally {
      tasks.lane.release(ROLLBACK);
    }
    await desktop.refresh();
    return c.json(desktop.get());
  });
