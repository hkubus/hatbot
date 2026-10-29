import { idParam } from "@hatbot/plugin-sdk";
import { Hono } from "hono";
import { requireAuth } from "../auth/middleware";
import type { AppEnv } from "../context";

const STATUSES = ["pending", "applied", "dismissed", "stale"] as const;

export const proposalRoutes = new Hono<AppEnv>()
  .use("/proposals", requireAuth)
  .use("/proposals/*", requireAuth)
  .use("/skills", requireAuth)
  .use("/skills/*", requireAuth)
  .get("/proposals", (c) => {
    const status = STATUSES.find((s) => s === c.req.query("status"));
    return c.json(c.var.proposals.list(status));
  })
  // A tidy-up of memory, written in the background: it comes as a proposal.updated event.
  .post("/proposals/tidy", (c) => {
    if (c.var.settings.get().paused) return c.json({ error: "Hatbot is paused." }, 409);
    c.var.proposals.startTidy();
    return c.json({ started: true }, 202);
  })
  .post("/proposals/:id/apply", async (c) => c.json(await c.var.proposals.apply(idParam(c))))
  .post("/proposals/:id/dismiss", (c) => c.json(c.var.proposals.dismiss(idParam(c))))
  .get("/skills", async (c) => c.json(await c.var.proposals.skillStatus()))
  .post("/skills/:name/fix", async (c) => {
    if (c.var.settings.get().paused) return c.json({ error: "Hatbot is paused." }, 409);
    await c.var.proposals.startFix(c.req.param("name"));
    return c.json({ started: true }, 202);
  });
