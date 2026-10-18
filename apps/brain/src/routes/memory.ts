import { PutMemoryFile } from "@hatbot/shared";
import { Hono } from "hono";
import { z } from "zod";
import { requireAuth } from "../auth/middleware";
import type { AppEnv } from "../context";
import { blobSha, MemoryConflict } from "../memory/store";
import { json, query } from "./util";

const PathQuery = z.object({ path: z.string().min(1) });

export const memoryRoutes = new Hono<AppEnv>()
  .use("/memory/*", requireAuth)
  .onError((err, c) => {
    if (err instanceof MemoryConflict)
      return c.json({ error: "changed", sha: err.sha, content: err.content }, 409);
    throw err;
  })
  .get("/memory/tree", async (c) => c.json(await c.var.memory.tree()))
  .get("/memory/file", query(PathQuery), async (c) => {
    const { path } = c.req.valid("query");
    const content = await c.var.memory.read(path);
    return c.json({ path, content, sha: blobSha(content) });
  })
  .put("/memory/file", query(PathQuery), json(PutMemoryFile), async (c) => {
    const { memory, settings } = c.var;
    const { path } = c.req.valid("query");
    const { content, message, baseSha } = c.req.valid("json");
    const owner = settings.get().owner;
    const what = message ?? `Edit ${path}`;
    // With baseSha, an edit made on top of an older copy is refused rather than lost.
    const sha =
      baseSha === undefined
        ? await memory.write(path, content, owner, what)
        : await memory.writeIf(path, content, baseSha, owner, what);
    return c.json({ sha });
  })
  .delete("/memory/file", query(PathQuery), async (c) => {
    const { memory, settings } = c.var;
    const { path } = c.req.valid("query");
    const sha = await memory.delete(path, settings.get().owner, `Delete ${path}`);
    return c.json({ sha });
  })
  .get(
    "/memory/log",
    query(
      z.object({
        path: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(500).optional(),
        skip: z.coerce.number().int().min(0).optional(),
      }),
    ),
    async (c) => {
      const { path, limit, skip } = c.req.valid("query");
      return c.json(await c.var.memory.log(limit, path, skip));
    },
  )
  .get("/memory/diff/:sha", async (c) =>
    c.json({ diff: await c.var.memory.diff(c.req.param("sha")) }),
  )
  .post("/memory/revert/:sha", async (c) => {
    const { memory, settings } = c.var;
    return c.json({ sha: await memory.revert(c.req.param("sha"), settings.get().owner) });
  });
