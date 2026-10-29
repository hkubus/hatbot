import { found, idParam } from "@hatbot/plugin-sdk";
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
  .get("/negotiations/:id", (c) =>
    found(c, c.var.negotiations.detail(idParam(c)), "No such negotiation."),
  )
  .post("/negotiations/:id/close", async (c) => {
    const n = idParam(c);
    if (!c.var.negotiations.get(n)) return c.json({ error: "No such negotiation." }, 404);
    if (!(await c.var.negotiations.stop(n))) return c.json({ error: "It has ended already." }, 409);
    return c.json(c.var.negotiations.detail(n));
  });
