import { PostMessage, SeenMessages } from "@hatbot/shared";
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
  // The conversations messages belong to, for their recaps where they fold up.
  .get("/thread/episodes", query(z.object({ ids: z.string().regex(/^\d+(,\d+){0,199}$/) })), (c) =>
    c.json(c.var.thread.episodes(c.req.valid("query").ids.split(",").map(Number))),
  )
  .post("/thread/messages", json(PostMessage), (c) => {
    const { message } = c.var.thread.post(c.req.valid("json").text);
    return c.json(message, 202);
  })
  // Unread: Hatbot's messages sent or edited since you last saw them.
  .get("/thread/unread", (c) => c.json(c.var.thread.unread()))
  .post("/thread/seen", json(SeenMessages), (c) => {
    c.var.thread.markSeen(c.req.valid("json").ids);
    return c.json({ ok: true });
  });
