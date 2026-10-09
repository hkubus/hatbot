import { PostMessage } from "@hatbot/shared";
import { Hono } from "hono";
import { z } from "zod";
import { requireAuth } from "../auth/middleware";
import type { AppEnv } from "../context";
import { json, query } from "./util";

export const threadRoutes = new Hono<AppEnv>()
  .use("/thread/*", requireAuth)
  .get(
    "/thread/messages",
    query(
      z.object({
        before: z.coerce.number().int().positive().optional(),
        limit: z.coerce.number().int().min(1).max(200).optional(),
      }),
    ),
    (c) => {
      const { before, limit } = c.req.valid("query");
      return c.json(c.var.thread.list(before, limit));
    },
  )
  .post("/thread/messages", json(PostMessage), (c) => {
    const { message } = c.var.thread.post(c.req.valid("json").text);
    return c.json(message, 202);
  });
