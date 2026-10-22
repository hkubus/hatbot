import { SetApiKey, SetNtfy } from "@hatbot/shared";
import { Hono } from "hono";
import { z } from "zod";
import { modelErrorText } from "../agent/model";
import { requireAuth } from "../auth/middleware";
import type { AppEnv, Deps } from "../context";
import { guessableTopic } from "../notify";
import { SettingsPatch } from "../settings";
import { json, query } from "./util";

export const spendDays = query(
  z.object({ days: z.coerce.number().int().min(1).max(366).default(30) }),
);

export function pauseAll(
  v: Pick<Deps, "settings" | "chats" | "tasks" | "desktop" | "events" | "boxes">,
) {
  v.settings.update({ paused: true });
  v.chats.abortAll();
  v.tasks.cancelAll();
  void v.desktop.setPaused(true);
  void v.boxes.backends?.stopAll();
  v.events.emit({ type: "paused", paused: true });
}

export const adminRoutes = new Hono<AppEnv>()
  .use("/spend/*", requireAuth)
  .use("/settings", requireAuth)
  .use("/connections", requireAuth)
  .use("/connections/*", requireAuth)
  .use("/pause-all", requireAuth)
  .use("/resume", requireAuth)
  .use("/update", requireAuth)
  .get("/spend/summary", (c) => c.json(c.var.spend.summary()))
  .get(
    "/spend/hourly",
    query(z.object({ hours: z.coerce.number().int().min(1).max(168).default(24) })),
    (c) => c.json(c.var.spend.hourly(c.req.valid("query").hours)),
  )
  .get("/spend/daily", spendDays, (c) => c.json(c.var.spend.daily(c.req.valid("query").days)))
  .get("/spend/by-model", spendDays, (c) => c.json(c.var.spend.byModel(c.req.valid("query").days)))
  .get("/spend/by-purpose", spendDays, (c) =>
    c.json(c.var.spend.byPurpose(c.req.valid("query").days)),
  )
  .get("/settings", (c) => c.json(c.var.settings.get()))
  .put("/settings", json(SettingsPatch.omit({ paused: true })), (c) => {
    const settings = c.var.settings.update(c.req.valid("json"));
    c.var.events.emit({ type: "settings.updated", settings });
    return c.json(settings);
  })
  // The API key and ntfy server: set here, they replace the host's until removed.
  .get("/connections", (c) => c.json(c.var.secrets.view()))
  .put("/connections/anthropic", json(SetApiKey), async (c) => {
    try {
      await c.var.secrets.setApiKey(c.req.valid("json").key);
    } catch (err) {
      return c.json({ error: `The key wasn't saved: ${modelErrorText(err)}.`, field: "key" }, 400);
    }
    return c.json(c.var.secrets.view());
  })
  .delete("/connections/anthropic", async (c) => {
    await c.var.secrets.setApiKey(null);
    return c.json(c.var.secrets.view());
  })
  .put("/connections/ntfy", json(SetNtfy), (c) => {
    const ntfy = c.req.valid("json");
    // Whoever guesses the topic may read every notification and press its Approve buttons.
    if (guessableTopic(ntfy.topic))
      return c.json(
        { error: "That topic is easy to guess. Use a long random one.", field: "topic" },
        400,
      );
    c.var.secrets.setNtfy(ntfy);
    return c.json(c.var.secrets.view());
  })
  .delete("/connections/ntfy", (c) => {
    c.var.secrets.setNtfy(null);
    return c.json(c.var.secrets.view());
  })
  // Resume is a separate, deliberate call.
  .post("/pause-all", (c) => {
    pauseAll(c.var);
    return c.json({ paused: true });
  })
  .post("/resume", (c) => {
    c.var.settings.update({ paused: false });
    void c.var.desktop.setPaused(false);
    c.var.events.emit({ type: "paused", paused: false });
    return c.json({ paused: false });
  })
  .get("/update", (c) => c.json(c.var.updates.info()))
  // Asks hatbot-update to pull from git and deploy. The brain restarts at the end.
  .post("/update", (c) => {
    const { updates, tasks } = c.var;
    const info = updates.info();
    if (!info.source)
      return c.json({ error: "Updates aren't set up; run deploy.sh on the host." }, 503);
    if (updates.running(info)) return c.json({ error: "Already updating." }, 409);
    if (tasks.list({ status: "active" }).length)
      return c.json({ error: "A task is running. Let it finish or cancel it first." }, 409);
    updates.request();
    return c.json(updates.info(), 202);
  });
