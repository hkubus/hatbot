import { Hono } from "hono";
import { requireAuth } from "../auth/middleware";
import type { AppEnv } from "../context";
import { search } from "../search";

export const searchRoutes = new Hono<AppEnv>()
  .use("/search", requireAuth)
  .get("/search", async (c) => c.json(await search(c.var, (c.req.query("q") ?? "").slice(0, 200))));
