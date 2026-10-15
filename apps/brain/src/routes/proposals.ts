import { Hono } from "hono";
import { requireAuth } from "../auth/middleware";
import type { AppEnv } from "../context";
import { ProposalError } from "../memory/proposals";
import { MemoryError } from "../memory/store";

const id = (c: { req: { param: (k: string) => string | undefined } }) => Number(c.req.param("id"));
const STATUSES = ["pending", "applied", "dismissed", "stale"] as const;

export const proposalRoutes = new Hono<AppEnv>()
  .use("/proposals", requireAuth)
  .use("/proposals/*", requireAuth)
  .use("/skills", requireAuth)
  .use("/skills/*", requireAuth)
  .onError((err, c) => {
    if (err instanceof ProposalError) return c.json({ error: err.message }, err.status);
    if (err instanceof MemoryError) return c.json({ error: err.message }, 400);
    throw err;
  })
  .get("/proposals", (c) => {
    const status = STATUSES.find((s) => s === c.req.query("status"));
    return c.json(c.var.proposals.list(status));
  })
  // A tidy-up of memory now. 204: it found nothing worth changing.
  .post("/proposals/tidy", async (c) => {
    if (c.var.settings.get().paused) return c.json({ error: "Hatbot is paused." }, 409);
    const p = await c.var.proposals.tidy();
    return p ? c.json(p, 201) : c.body(null, 204);
  })
  .post("/proposals/:id/apply", async (c) => c.json(await c.var.proposals.apply(id(c))))
  .post("/proposals/:id/dismiss", (c) => c.json(c.var.proposals.dismiss(id(c))))
  .get("/skills", async (c) => c.json(await c.var.proposals.skillStatus()))
  // A fix for a skill whose tasks failed or needed you. 204: the model saw nothing to change.
  .post("/skills/:name/fix", async (c) => {
    if (c.var.settings.get().paused) return c.json({ error: "Hatbot is paused." }, 409);
    const p = await c.var.proposals.fixSkill(c.req.param("name"));
    return p ? c.json(p, 201) : c.body(null, 204);
  });
