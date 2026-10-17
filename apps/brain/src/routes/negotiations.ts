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
  });
