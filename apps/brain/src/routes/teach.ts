import { SaveSkill } from "@hatbot/shared";
import { Hono } from "hono";
import { z } from "zod";
import { requireAuth } from "../auth/middleware";
import type { AppEnv } from "../context";
import { TeachError } from "../teach/service";
import { found, json } from "./util";

const id = (raw: string) => {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new TeachError("No such recording.", 404);
  return n;
};

export const teachRoutes = new Hono<AppEnv>()
  .use("/teach", requireAuth)
  .use("/teach/*", requireAuth)
  .get("/teach", (c) => c.json(c.var.teach.current()))
  // replaces: a skill to record again; the draft keeps its name.
  .post("/teach/start", json(z.object({ replaces: SaveSkill.shape.name.optional() })), async (c) =>
    c.json(await c.var.teach.start(c.req.valid("json").replaces)),
  )
  .post("/teach/stop", async (c) => c.json(await c.var.teach.stop()))
  .get("/teach/:id", (c) => found(c, c.var.teach.get(id(c.req.param("id"))), "No such recording."))
  .post("/teach/:id/draft", (c) => c.json(c.var.teach.redraft(id(c.req.param("id")))))
  .post("/teach/:id/save", json(SaveSkill.extend({ replace: z.boolean().optional() })), async (c) =>
    c.json(await c.var.teach.save(id(c.req.param("id")), c.req.valid("json"))),
  )
  .delete("/teach/:id", async (c) => c.json(await c.var.teach.discard(id(c.req.param("id")))));
