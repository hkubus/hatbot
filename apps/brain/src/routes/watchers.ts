import { CreateWatcher, HATBOT_ID, UpdateWatcher, WatchSourceInput } from "@hatbot/shared";
import { Hono } from "hono";
import { z } from "zod";
import { requireAuth } from "../auth/middleware";
import type { AppEnv } from "../context";
import { WatchError } from "../watch/service";
import { json } from "./util";

const id = (c: { req: { param: (k: string) => string | undefined } }) => Number(c.req.param("id"));

/** Unset, or a bot that isn't deleted. */
const knownBot = (c: { var: AppEnv["Variables"] }, botId: string | undefined) =>
  botId === undefined || c.var.bots.active(botId) !== null;

const Preview = z.object({ source: WatchSourceInput, botId: z.string().optional() });

export const watcherRoutes = new Hono<AppEnv>()
  .use("/watchers", requireAuth)
  .use("/watchers/*", requireAuth)
  .get("/watchers", (c) => c.json(c.var.watchers.list()))
  .post("/watchers", json(CreateWatcher), async (c) => {
    if (!knownBot(c, c.req.valid("json").botId)) return c.json({ error: "No such bot." }, 400);
    try {
      return c.json(await c.var.watchers.create(c.req.valid("json"), "owner"), 201);
    } catch (err) {
      if (err instanceof WatchError) return c.json({ error: err.message }, 400);
      throw err;
    }
  })
  // What a check would find now: the form's Try button.
  .post("/watchers/preview", json(Preview), async (c) => {
    const { source, botId } = c.req.valid("json");
    if (!knownBot(c, botId)) return c.json({ error: "No such bot." }, 400);
    return c.json(await c.var.watchers.preview(source, botId ?? HATBOT_ID));
  })
  .get("/watchers/:id", (c) => {
    const w = c.var.watchers.get(id(c));
    return w ? c.json(w) : c.json({ error: "not found" }, 404);
  })
  .get("/watchers/:id/values", (c) => {
    if (!c.var.watchers.get(id(c))) return c.json({ error: "not found" }, 404);
    const limit = Math.min(500, Math.max(1, Number(c.req.query("limit") ?? 100) || 100));
    return c.json(c.var.watchers.values(id(c), limit));
  })
  .patch("/watchers/:id", json(UpdateWatcher), async (c) => {
    if (!knownBot(c, c.req.valid("json").botId)) return c.json({ error: "No such bot." }, 400);
    try {
      const w = await c.var.watchers.update(id(c), c.req.valid("json"));
      return w ? c.json(w) : c.json({ error: "not found" }, 404);
    } catch (err) {
      if (err instanceof WatchError) return c.json({ error: err.message }, 400);
      throw err;
    }
  })
  .post("/watchers/:id/check", async (c) => {
    if (!c.var.watchers.get(id(c))) return c.json({ error: "not found" }, 404);
    if (c.var.settings.get().paused) return c.json({ error: "Hatbot is paused." }, 409);
    return c.json(await c.var.watchers.checkNow(id(c)));
  })
  .delete("/watchers/:id", (c) =>
    c.var.watchers.delete(id(c)) ? c.json({ ok: true }) : c.json({ error: "not found" }, 404),
  );
