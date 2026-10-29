import { bodyOf, type PluginEnv } from "@hatbot/plugin-sdk";
import { SaveSkill } from "@hatbot/shared";
import type { Hono } from "hono";
import { z } from "zod";
import { type Teach, TeachError } from "./service";

const id = (raw: string) => {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new TeachError("No such recording.", 404);
  return n;
};

const Start = z.object({ replaces: SaveSkill.shape.name.optional() });
const Save = SaveSkill.extend({ replace: z.boolean().optional() });

/** Teach-by-showing's, on `app`. */
export const teachRoutes = (app: Hono<PluginEnv>, teach: Teach) =>
  app
    .get("/teach", (c) => c.json(teach.current()))
    // replaces: a skill to record again; the draft keeps its name.
    .post("/teach/start", async (c) => c.json(await teach.start((await bodyOf(c, Start)).replaces)))
    .post("/teach/stop", async (c) => c.json(await teach.stop()))
    .get("/teach/:id", (c) => {
      const session = teach.get(id(c.req.param("id")));
      return session ? c.json(session) : c.json({ error: "No such recording." }, 404);
    })
    .post("/teach/:id/draft", (c) => c.json(teach.redraft(id(c.req.param("id")))))
    .post("/teach/:id/save", async (c) =>
      c.json(await teach.save(id(c.req.param("id")), await bodyOf(c, Save))),
    )
    .delete("/teach/:id", async (c) => c.json(await teach.discard(id(c.req.param("id")))));
