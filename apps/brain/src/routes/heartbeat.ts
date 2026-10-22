import { Hono } from "hono";
import { requireAuth } from "../auth/middleware";
import type { AppEnv } from "../context";

export const heartbeatRoutes = new Hono<AppEnv>()
  .use("/heartbeat", requireAuth)
  .use("/heartbeat/*", requireAuth)
  .use("/report", requireAuth)
  .use("/report/*", requireAuth)
  .get("/heartbeat", (c) => c.json(c.var.heartbeat.info()))
  .post("/heartbeat/run", async (c) => {
    if (c.var.settings.get().paused) return c.json({ error: "Hatbot is paused." }, 409);
    return c.json(await c.var.heartbeat.run());
  })
  .get("/report", async (c) => c.json(await c.var.report.make()))
  .post("/report/send", async (c) => c.json({ text: await c.var.report.send() }));
