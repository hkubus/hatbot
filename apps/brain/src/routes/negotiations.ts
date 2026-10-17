import { Hono } from "hono";
import { requireAuth } from "../auth/middleware";
import type { AppEnv } from "../context";

export const negotiationRoutes = new Hono<AppEnv>()
  .use("/negotiations", requireAuth)
  .use("/negotiations/*", requireAuth)
  .get("/negotiations", (c) => {
    const status = c.req.query("status");
    return c.json(
      c.var.negotiations.list({
        open: status === "open" ? true : status === "closed" ? false : undefined,
      }),
    );
  })
  .get("/negotiations/:id", (c) => {
    const d = c.var.negotiations.detail(Number(c.req.param("id")));
    return d ? c.json(d) : c.json({ error: "No such negotiation." }, 404);
  })
  // Stop: abandoned, and its tasks cancelled.
  .post("/negotiations/:id/close", async (c) => {
    const id = Number(c.req.param("id"));
    if (!c.var.negotiations.get(id)) return c.json({ error: "No such negotiation." }, 404);
    const n = await c.var.negotiations.stop(id);
    if (!n) return c.json({ error: "It has ended already." }, 409);
    return c.json(c.var.negotiations.detail(id));
  });
