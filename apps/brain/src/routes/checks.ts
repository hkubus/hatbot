import { Hono } from "hono";
import { requireAuth } from "../auth/middleware";
import { reportText } from "../checks";
import type { AppEnv } from "../context";

export const checkRoutes = new Hono<AppEnv>()
  .use("/checks", requireAuth)
  .use("/checks/*", requireAuth)
  .get("/checks", (c) => c.json(c.var.checks.info()))
  // ?text=1 answers in plain lines, for infra/smoke.sh.
  .post("/checks", async (c) => {
    const report = await c.var.checks.run();
    if (c.req.query("text") === "1") return c.text(reportText(report));
    return c.json(report);
  })
  .post("/checks/approval", (c) => c.json(c.var.checks.tryApproval()));
