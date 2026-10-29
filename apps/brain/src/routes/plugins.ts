import { PluginError } from "@hatbot/plugin-sdk";
import { InstallPlugin, SetPluginSecrets, UpdatePlugin } from "@hatbot/shared";
import { Hono } from "hono";
import { z } from "zod";
import { requireAuth } from "../auth/middleware";
import type { AppEnv } from "../context";
import { pluginIndex } from "../plugins/installer";
import { found, json } from "./util";

export const pluginRoutes = new Hono<AppEnv>()
  .use("/plugins", requireAuth)
  .use("/plugins/*", requireAuth)
  .get("/plugins", (c) => c.json(c.var.plugins.list()))
  // What plugins.json offers, and whether each is in.
  .get("/plugins/index", (c) => {
    const have = new Set(c.var.plugins.list().map((p) => p.id));
    return c.json(pluginIndex().map((p) => ({ ...p, installed: have.has(p.id) })));
  })
  // Runs the plugin's code in the brain: only the owner gets here. The brain then starts again.
  .post("/plugins/install", json(InstallPlugin), async (c) => {
    const busy = restartBlocked(c.var);
    if (busy) return c.json({ error: busy }, 409);
    const { url, commit } = c.req.valid("json");
    const done = await c.var.installer.install(url.trim(), commit.trim().toLowerCase());
    c.var.restart();
    return c.json(done, 201);
  })
  // Its files go, and with ?data=1, what it kept too.
  .delete("/plugins/:id", async (c) => {
    const { plugins, installer } = c.var;
    const id = c.req.param("id");
    if (!plugins.get(id)) return c.json({ error: "That's gone." }, 404);
    if (!installer.get(id))
      return c.json({ error: "It comes with Hatbot: switch it off instead." }, 400);
    const busy = restartBlocked(c.var);
    if (busy) return c.json({ error: busy }, 409);
    if (c.req.query("data") === "1") {
      await plugins.update(id, { enabled: false });
      plugins.forget(id);
    }
    installer.uninstall(id);
    c.var.restart();
    return c.json({ ok: true });
  })
  .post("/plugins/:id/forget", (c) => {
    const { plugins } = c.var;
    const id = c.req.param("id");
    if (!plugins.get(id)) return c.json({ error: "That's gone." }, 404);
    return c.json(plugins.forget(id));
  })
  .get("/plugins/:id", (c) => found(c, c.var.plugins.get(c.req.param("id"))))
  .patch("/plugins/:id", json(UpdatePlugin), async (c) => {
    const { plugins } = c.var;
    const id = c.req.param("id");
    if (!plugins.get(id)) return c.json({ error: "That's gone." }, 404);
    return c.json(await plugins.update(id, c.req.valid("json")));
  })
  // A secret is only ever sent: what comes back says it's set, not what to.
  .put("/plugins/:id/secrets", json(SetPluginSecrets), async (c) => {
    const { plugins } = c.var;
    const id = c.req.param("id");
    if (!plugins.get(id)) return c.json({ error: "That's gone." }, 404);
    return c.json(await plugins.setSecrets(id, c.req.valid("json").values));
  })
  .post("/plugins/:id/actions/:name", json(z.unknown()), async (c) => {
    const { id, name } = c.req.param();
    return c.json({ result: await c.var.plugins.action(id, name, c.req.valid("json")) });
  })
  .post("/plugins/:id/test", async (c) => {
    try {
      return c.json({ ok: true, message: await c.var.plugins.test(c.req.param("id")) });
    } catch (err) {
      if (err instanceof PluginError) return c.json({ ok: false, message: err.message });
      console.error("plugin test failed", err);
      return c.json({ ok: false, message: "The test failed; see the brain's log." });
    }
  });

/** Why the brain can't start again now, or null. */
function restartBlocked({ tasks }: AppEnv["Variables"]): string | null {
  return tasks.list({ status: "active" }).length
    ? "A task is running. Let it finish or cancel it first."
    : null;
}
