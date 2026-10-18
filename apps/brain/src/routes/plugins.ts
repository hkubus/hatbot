import { UpdatePlugin } from "@hatbot/shared";
import { Hono } from "hono";
import { requireAuth } from "../auth/middleware";
import type { AppEnv } from "../context";
import { PluginError } from "../plugins/plugin";
import { json, signedOut } from "./util";

// Plugins in Settings (PLAN.md §4.5): switch on or off, change settings, test.
export const pluginRoutes = new Hono<AppEnv>()
  .use("/plugins", requireAuth)
  .use("/plugins/*", requireAuth)
  .get("/plugins", (c) => c.json(c.var.plugins.list()))
  .get("/plugins/:id", (c) => {
    const p = c.var.plugins.get(c.req.param("id"));
    return p ? c.json(p) : c.json({ error: "That's gone." }, 404);
  })
  .patch("/plugins/:id", json(UpdatePlugin), async (c) => {
    const { plugins } = c.var;
    const id = c.req.param("id");
    if (!plugins.get(id)) return c.json({ error: "That's gone." }, 404);
    return c.json(await plugins.update(id, c.req.valid("json")));
  })
  .post("/plugins/:id/actions/:name", async (c) => {
    const args = await c.req.json().catch(() => ({}));
    if (signedOut(c)) return c.json({ error: "You're not signed in." }, 401);
    return c.json({
      result: await c.var.plugins.action(c.req.param("id"), c.req.param("name"), args),
    });
  })
  .post("/plugins/:id/test", async (c) => {
    try {
      return c.json({ ok: true, message: await c.var.plugins.test(c.req.param("id")) });
    } catch (err) {
      if (err instanceof PluginError) return c.json({ ok: false, message: err.message });
      console.error("plugin test failed", err);
      return c.json({ ok: false, message: "The test failed; see the brain's log." });
    }
  })
  // A plugin's own refusal, such as bad settings, is shown as it is; anything else is the app's.
  .onError((err, c) => {
    if (err instanceof PluginError) return c.json({ error: err.message }, 400);
    throw err;
  });
