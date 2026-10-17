import { Hono } from "hono";
import { z } from "zod";
import { requireAuth } from "../auth/middleware";
import type { AppEnv, Deps } from "../context";
import { SettingsPatch } from "../settings";
import { json, query } from "./util";

/** The kill switch (PLAN.md §6.5): from Settings, or a notification's Pause all. */
export function pauseAll(v: Pick<Deps, "settings" | "chats" | "tasks" | "desktop" | "events">) {
  v.settings.update({ paused: true });
  v.chats.abortAll();
  v.tasks.cancelAll();
  void v.desktop.setPaused(true);
  v.events.emit({ type: "paused", paused: true });
}

export const adminRoutes = new Hono<AppEnv>()
  .use("/spend/*", requireAuth)
  .use("/settings", requireAuth)
  .use("/pause-all", requireAuth)
  .use("/resume", requireAuth)
  .use("/update", requireAuth)
  .get("/spend/summary", (c) => c.json(c.var.spend.summary()))
  .get(
    "/spend/hourly",
    query(z.object({ hours: z.coerce.number().int().min(1).max(168).default(24) })),
    (c) => c.json(c.var.spend.hourly(c.req.valid("query").hours)),
  )
  .get(
    "/spend/daily",
    query(z.object({ days: z.coerce.number().int().min(1).max(366).default(30) })),
    (c) => c.json(c.var.spend.daily(c.req.valid("query").days)),
  )
  .get(
    "/spend/by-model",
    query(z.object({ days: z.coerce.number().int().min(1).max(366).default(30) })),
    (c) => c.json(c.var.spend.byModel(c.req.valid("query").days)),
  )
  .get(
    "/spend/by-purpose",
    query(z.object({ days: z.coerce.number().int().min(1).max(366).default(30) })),
    (c) => c.json(c.var.spend.byPurpose(c.req.valid("query").days)),
  )
  .get("/settings", (c) => c.json(c.var.settings.get()))
  .put("/settings", json(SettingsPatch.omit({ paused: true })), (c) => {
    const settings = c.var.settings.update(c.req.valid("json"));
    c.var.events.emit({ type: "settings.updated", settings });
    return c.json(settings);
  })
  // Kill switch (PLAN.md §6.5). Resume is a separate, deliberate call.
  .post("/pause-all", (c) => {
    pauseAll(c.var);
    return c.json({ paused: true });
  })
  .post("/resume", (c) => {
    c.var.settings.update({ paused: false });
    void c.var.desktop.setPaused(false);
    c.var.events.emit({ type: "paused", paused: false });
    return c.json({ paused: false });
  })
  .get("/update", (c) => c.json(c.var.updates.info()))
  // Asks hatbot-update to pull from git and deploy. The brain restarts at the end.
  .post("/update", (c) => {
    const { updates, tasks } = c.var;
    const info = updates.info();
    if (!info.source)
      return c.json({ error: "Updates aren't set up; run deploy.sh on the host." }, 503);
    if (updates.running(info)) return c.json({ error: "Already updating." }, 409);
    if (tasks.list({ status: "active" }).length)
      return c.json({ error: "A task is running. Let it finish or cancel it first." }, 409);
    updates.request();
    return c.json(updates.info(), 202);
  });
