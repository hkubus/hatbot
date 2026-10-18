import { CreateWatcher, HATBOT_ID, UpdateWatcher, WatchSourceInput } from "@hatbot/shared";
import { Hono } from "hono";
import { z } from "zod";
import { requireAuth } from "../auth/middleware";
import type { AppEnv } from "../context";
import { WatchError } from "../watch/service";
import { json } from "./util";

const id = (c: { req: { param: (k: string) => string | undefined } }) => Number(c.req.param("id"));

const gone = (): never => {
  throw new WatchError("That's gone.", 404);
};

/** Throws unless it's unset or a bot that isn't deleted. */
const knownBot = (c: { var: AppEnv["Variables"] }, botId: string | undefined) => {
  if (botId !== undefined && !c.var.bots.active(botId)) throw new WatchError("No such bot.");
};

const Preview = z.object({ source: WatchSourceInput, botId: z.string().optional() });

export const watcherRoutes = new Hono<AppEnv>()
  .use("/watchers", requireAuth)
  .use("/watchers/*", requireAuth)
  .onError((err, c) => {
    if (err instanceof WatchError) return c.json({ error: err.message }, err.status);
    throw err;
  })
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
  .get("/watchers/:id", (c) => c.json(c.var.watchers.get(id(c)) ?? gone()))
  .get("/watchers/:id/values", (c) => {
    if (!c.var.watchers.get(id(c))) gone();
    const limit = Math.min(500, Math.max(1, Number(c.req.query("limit") ?? 100) || 100));
    return c.json(c.var.watchers.values(id(c), limit));
  })
  .patch("/watchers/:id", json(UpdateWatcher), async (c) => {
    knownBot(c, c.req.valid("json").botId);
    return c.json((await c.var.watchers.update(id(c), c.req.valid("json"))) ?? gone());
  })
  .post("/watchers/:id/check", async (c) => {
    if (!c.var.watchers.get(id(c))) gone();
    if (c.var.settings.get().paused) return c.json({ error: "Hatbot is paused." }, 409);
    return c.json(await c.var.watchers.checkNow(id(c)));
  })
  .delete("/watchers/:id", (c) => (c.var.watchers.delete(id(c)) ? c.json({ ok: true }) : gone()));
