import { CreateWatcher, HATBOT_ID, UpdateWatcher, WatchSourceInput } from "@hatbot/shared";
import { Hono } from "hono";
import { z } from "zod";
import { requireAuth } from "../auth/middleware";
import type { AppEnv } from "../context";
import { WatchError } from "../watch/service";
import { found, id, json, knownBot } from "./util";

const gone = (): never => {
  throw new WatchError("That's gone.", 404);
};

const Preview = z.object({ source: WatchSourceInput, botId: z.string().optional() });

export const watcherRoutes = new Hono<AppEnv>()
  .use("/watchers", requireAuth)
  .use("/watchers/*", requireAuth)
  .get("/watchers", (c) => c.json(c.var.watchers.list()))
  .post("/watchers", json(CreateWatcher), async (c) => {
    knownBot(c, c.req.valid("json").botId);
    return c.json(await c.var.watchers.create(c.req.valid("json"), "owner"), 201);
  })
  // What a check would find now: the form's Try button.
  .post("/watchers/preview", json(Preview), async (c) => {
    const { source, botId } = c.req.valid("json");
    knownBot(c, botId);
    return c.json(await c.var.watchers.preview(source, botId ?? HATBOT_ID));
  })
  .get("/watchers/:id", (c) => found(c, c.var.watchers.get(id(c))))
  .get("/watchers/:id/values", (c) => {
    if (!c.var.watchers.get(id(c))) gone();
    const limit = Math.min(500, Math.max(1, Number(c.req.query("limit") ?? 100) || 100));
    return c.json(c.var.watchers.values(id(c), limit));
  })
  .patch("/watchers/:id", json(UpdateWatcher), async (c) => {
    knownBot(c, c.req.valid("json").botId);
    return found(c, await c.var.watchers.update(id(c), c.req.valid("json")));
  })
  .post("/watchers/:id/check", async (c) => {
    if (!c.var.watchers.get(id(c))) gone();
    if (c.var.settings.get().paused) return c.json({ error: "Hatbot is paused." }, 409);
    return c.json(await c.var.watchers.checkNow(id(c)));
  })
  .post("/watchers/:id/trust", (c) => found(c, c.var.watchers.trust(id(c))))
  .delete("/watchers/:id", (c) => (c.var.watchers.delete(id(c)) ? c.json({ ok: true }) : gone()));
