import { BOT_TEMPLATES, CreateBot, HATBOT_ID, UpdateBot } from "@hatbot/shared";
import { Hono } from "hono";
import { z } from "zod";
import { requireAuth } from "../auth/middleware";
import { briefBot } from "../bots";
import type { AppEnv } from "../context";
import { modelProblem } from "../models-known";
import { spendDays } from "./admin";
import { found, json, query } from "./util";

export const botRoutes = new Hono<AppEnv>()
  .use("/bots", requireAuth)
  .use("/bots/*", requireAuth)
  .use("/bot-templates", requireAuth)
  .use("/spend/by-bot", requireAuth)
  // brief=1 for lists, which show a role's first line; older apps edit the role from this list.
  .get("/bots", query(z.object({ brief: z.enum(["0", "1"]).optional() })), (c) => {
    const list = c.var.bots.list();
    return c.json(c.req.valid("query").brief === "1" ? list.map(briefBot) : list);
  })
  // Not under /bots/, where a bot called Templates would have it as its id.
  .get("/bot-templates", (c) => c.json(BOT_TEMPLATES))
  .post("/bots", json(CreateBot), (c) => {
    const problem = modelProblem(c.req.valid("json"));
    if (problem) return c.json(problem, 400);
    const bot = c.var.bots.create(c.req.valid("json"));
    c.var.chats.changed(c.var.chats.direct(bot.id).conversationId);
    return c.json(bot, 201);
  })
  .get("/bots/:id", (c) => found(c, c.var.bots.active(c.req.param("id"))))
  .patch("/bots/:id", json(UpdateBot), (c) => {
    const problem = modelProblem(c.req.valid("json"));
    if (problem) return c.json(problem, 400);
    return found(c, c.var.bots.update(c.req.param("id"), c.req.valid("json")));
  })
  .delete("/bots/:id", (c) => {
    const id = c.req.param("id");
    const moved = c.var.bots.delete(id);
    if (!moved) return c.json({ error: "That's gone." }, 404);
    const { events, schedules, triggers, watchers, settings, chats, boxes } = c.var;
    // Its reply in progress stops: it mustn't make more as a bot that's gone.
    chats.abortBot(id);
    boxes.orphan(id);
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
  })
  .get("/spend/by-bot", spendDays, (c) => c.json(c.var.spend.byBot(c.req.valid("query").days)));
