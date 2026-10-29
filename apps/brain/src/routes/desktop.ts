import { PluginError } from "@hatbot/plugin-sdk";
import { Hono } from "hono";
import { z } from "zod";
import { requireAuth } from "../auth/middleware";
import type { AppEnv } from "../context";
import { json } from "./util";

/** Holds the screen lane while the desktop rolls back, so no task starts on it. */
const ROLLBACK = -1;

// The desktop's nightly snapshots are Proxmox's; the rest of /desktop is the Desktop plugin's.
export const desktopRoutes = new Hono<AppEnv>()
  .use("/desktop/snapshots", requireAuth)
  .use("/desktop/rollback", requireAuth)
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
    const { tasks } = c.var;
    const desktop = c.var.desktop();
    const proxmox = c.var.proxmox();
    if (!proxmox.configured) return c.json({ error: "Proxmox isn't set up." }, 503);
    if (!desktop) return c.json({ error: "The Desktop plugin is off." }, 503);
    const { lane, control } = desktop;
    if (lane.holderId === ROLLBACK) return c.json({ error: "Already rolling back." }, 409);
    if (tasks.list({ status: "active" }).some((t) => t.lane === "screen"))
      return c.json({ error: "A task is using the desktop. Cancel it first." }, 409);
    if (control.get().control === "owner")
      return c.json({ error: "Hand the desktop back first." }, 409);
    await lane.acquire(ROLLBACK, new AbortController().signal);
    try {
      await proxmox.rollbackDesktop(c.req.valid("json").name);
    } catch (err) {
      const status = err instanceof PluginError && err.status === 400 ? 400 : 502;
      return c.json(
        { error: err instanceof PluginError ? err.message : "Rollback failed" },
        status,
      );
    } finally {
      lane.release(ROLLBACK);
    }
    await control.refresh();
    return c.json(control.get());
  });
