import { Hono } from "hono";
import { z } from "zod";
import { requireAuth } from "../auth/middleware";
import type { AppEnv } from "../context";
import { Settings } from "../settings";
import { json, query } from "./util";

export const adminRoutes = new Hono<AppEnv>()
  .use("/spend/*", requireAuth)
  .use("/settings", requireAuth)
  .use("/pause-all", requireAuth)
  .use("/resume", requireAuth)
  .get("/spend/summary", (c) => c.json(c.var.spend.summary()))
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
  .get("/settings", (c) => c.json(c.var.settings.get()))
  .put("/settings", json(Settings.omit({ paused: true }).partial()), (c) =>
    c.json(c.var.settings.update(c.req.valid("json"))),
  )
  // Kill switch (PLAN.md §6.5). Resume is a separate, deliberate call.
  .post("/pause-all", (c) => {
    c.var.settings.update({ paused: true });
    c.var.thread.abortCurrent();
    c.var.events.emit({ type: "paused", paused: true });
    return c.json({ paused: true });
  })
  .post("/resume", (c) => {
    c.var.settings.update({ paused: false });
    c.var.events.emit({ type: "paused", paused: false });
    return c.json({ paused: false });
  });
