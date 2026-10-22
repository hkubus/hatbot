import type { LiveInput } from "@hatbot/shared/desktop";
import { type Context, Hono } from "hono";
import { upgradeWebSocket } from "hono/bun";
import { z } from "zod";
import { principalOf, requireAuth } from "../auth/middleware";
import type { AppEnv } from "../context";
import { DesktopBusy } from "../desktop/service";
import { PluginError } from "../plugins/plugin";
import { json } from "./util";

/** Holds the screen lane while the desktop rolls back, so no task starts on it. */
const ROLLBACK = -1;
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

/**
 * One viewer's frames. On a slow connection, skip frames rather than fall behind the desktop: the
 * newest goes out once the viewer catches up, since a desktop that has gone still sends nothing more.
 * `later` runs a look again after a while.
 */
export function frameRelay(
  send: (frame: ArrayBuffer) => void,
  buffered: () => number,
  later = (fn: () => void) => void setTimeout(fn, 100),
) {
  let behind: ArrayBuffer | null = null;
  let waiting = false;
  const flush = () => {
    waiting = false;
    if (!behind) return;
    if (buffered() < LIVE_BUFFER_BYTES) {
      send(behind);
      behind = null;
    } else {
      waiting = true;
      later(flush);
    }
  };
  return {
    push(frame: ArrayBuffer) {
      behind = frame;
      if (!waiting) flush();
    },
    stop() {
      behind = null;
    },
  };
}

export const desktopRoutes = new Hono<AppEnv>()
  .get(
    "/desktop/live",
    // Same rules as /stream: a cookie needs the public Origin, an app uses its bearer token.
    async (c, next) => {
      const principal = principalOf(c, { renew: false });
      if (!principal) return c.json({ error: "You're not signed in." }, 401);
      const { publicUrl } = c.var.config;
      if (principal.kind === "session" && c.req.header("origin") !== publicUrl)
        return c.json({ error: `Open Hatbot at ${publicUrl} to make changes.` }, 403);
      if (!c.var.desktop.agent.configured)
        return c.json({ error: "The desktop isn't set up." }, 503);
      c.set("principal", principal);
      await next();
    },
    // JPEG frames from desktop-agent out, your input in while you have control.
    upgradeWebSocket((c) => {
      const { desktop, teach, auth, principal } = (c as Context<AppEnv>).var;
      let upstream: WebSocket | null = null;
      let frames: ReturnType<typeof frameRelay> | undefined;
      let forget: (() => void) | undefined;
      let sent = false;
      return {
        onOpen(_, ws) {
          // Signing out or revoking the token ends the live view too.
          forget = auth.onEnd(principal, () => ws.close(1008, "Signed out"));
          const { url, headers } = desktop.agent.liveSocket();
          const raw = ws.raw as { getBufferedAmount?: () => number } | undefined;
          frames = frameRelay(
            (frame) => ws.send(frame),
            () => raw?.getBufferedAmount?.() ?? 0,
          );
          upstream = new WebSocket(url, { headers } as unknown as string[]);
          upstream.binaryType = "arraybuffer";
          upstream.onmessage = (e) => frames?.push(e.data as ArrayBuffer);
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
            sent = true;
          }
        },
        onClose() {
          frames?.stop();
          upstream?.close();
          forget?.();
          if (sent) teach.viewerGone();
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
    const proxmox = c.var.proxmox();
    if (!proxmox.configured) return c.json({ configured: false, snapshots: [] });
    try {
      return c.json({ configured: true, snapshots: await proxmox.desktopSnapshots() });
    } catch (err) {
      return c.json({ error: err instanceof PluginError ? err.message : "Proxmox failed" }, 502);
    }
  })
  // Back to a nightly snapshot, then started again.
  .post("/desktop/rollback", json(z.object({ name: z.string().min(1).max(40) })), async (c) => {
    const { tasks, desktop } = c.var;
    const proxmox = c.var.proxmox();
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
      const status = err instanceof PluginError && err.status === 400 ? 400 : 502;
      return c.json(
        { error: err instanceof PluginError ? err.message : "Rollback failed" },
        status,
      );
    } finally {
      tasks.lane.release(ROLLBACK);
    }
    await desktop.refresh();
    return c.json(desktop.get());
  });
