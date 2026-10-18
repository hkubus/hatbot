import { BOT_TEMPLATES, CreateBot, HATBOT_ID, UpdateBot } from "@hatbot/shared";
import { Hono } from "hono";
import { requireAuth } from "../auth/middleware";
import { BotError } from "../bots";
import type { AppEnv } from "../context";
import { spendDays } from "./admin";
import { json } from "./util";

export const botRoutes = new Hono<AppEnv>()
  .use("/bots", requireAuth)
  .use("/bots/*", requireAuth)
  .use("/bot-templates", requireAuth)
  .use("/spend/by-bot", requireAuth)
  .get("/bots", (c) => c.json(c.var.bots.list()))
  // Not under /bots/, where a bot called Templates would have it as its id.
  .get("/bot-templates", (c) => c.json(BOT_TEMPLATES))
  .post("/bots", json(CreateBot), (c) => {
    try {
      const bot = c.var.bots.create(c.req.valid("json"));
      // Its own chat, so it's in the list straight away.
      c.var.chats.changed(c.var.chats.direct(bot.id).conversationId);
      return c.json(bot, 201);
    } catch (err) {
      if (err instanceof BotError) return c.json({ error: err.message }, 400);
      throw err;
    }
  })
  .get("/bots/:id", (c) => {
    const bot = c.var.bots.active(c.req.param("id"));
    return bot ? c.json(bot) : c.json({ error: "That's gone." }, 404);
  })
  .patch("/bots/:id", json(UpdateBot), (c) => {
    try {
      const bot = c.var.bots.update(c.req.param("id"), c.req.valid("json"));
      return bot ? c.json(bot) : c.json({ error: "That's gone." }, 404);
    } catch (err) {
      if (err instanceof BotError) return c.json({ error: err.message }, 400);
      throw err;
    }
  })
  .delete("/bots/:id", (c) => {
    try {
      const id = c.req.param("id");
      const moved = c.var.bots.delete(id);
      if (!moved) return c.json({ error: "That's gone." }, 404);
      const { events, schedules, triggers, watchers, settings, chats } = c.var;
      // Its reply in progress stops: it mustn't make more as a bot that's gone.
      chats.abortBot(id);
      // A heartbeat that ran as it is switched off, as its automations are.
      const { heartbeat } = settings.get();
      if (heartbeat.botId === id)
        settings.update({ heartbeat: { ...heartbeat, enabled: false, botId: HATBOT_ID } });
      for (const id of moved.schedules) {
        const schedule = schedules.get(id);
        if (schedule) events.emit({ type: "schedule.updated", schedule });
      }
      for (const id of moved.triggers) {
        const trigger = triggers.get(id);
        if (trigger) events.emit({ type: "trigger.updated", trigger });
      }
      for (const id of moved.watchers) {
        const watcher = watchers.get(id);
        if (watcher) events.emit({ type: "watcher.updated", watcher });
      }
      return c.json({ ok: true });
    } catch (err) {
      if (err instanceof BotError) return c.json({ error: err.message }, 400);
      throw err;
    }
  })
  .get("/spend/by-bot", spendDays, (c) => c.json(c.var.spend.byBot(c.req.valid("query").days)));
