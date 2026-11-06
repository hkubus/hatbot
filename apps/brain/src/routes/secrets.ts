// Settings → Secrets: what the owner keeps for the bots to place by name. Only you see a value.
import { SecretName, SetSecret } from "@hatbot/shared";
import { Hono } from "hono";
import { requireAuth } from "../auth/middleware";
import type { AppEnv } from "../context";
import { json } from "./util";

const nameOf = (raw: string) => {
  const r = SecretName.safeParse(raw);
  return r.success ? r.data : null;
};

export const secretRoutes = new Hono<AppEnv>()
  .use("/secrets", requireAuth)
  .use("/secrets/*", requireAuth)
  .get("/secrets", (c) => c.json(c.var.secrets.vault()))
  .put("/secrets/:name", json(SetSecret), (c) => {
    const name = nameOf(c.req.param("name"));
    if (!name)
      return c.json(
        { error: "A name in capitals, digits and underscores, like GITEA_TOKEN.", field: "name" },
        400,
      );
    c.var.secrets.setSecret(name, c.req.valid("json").value);
    return c.json(c.var.secrets.vault().find((s) => s.name === name));
  })
  .post("/secrets/:name/show", (c) => {
    const value = c.var.secrets.secret(c.req.param("name"));
    if (value === null) return c.json({ error: "That's gone." }, 404);
    c.header("cache-control", "no-store");
    return c.json({ value });
  })
  .delete("/secrets/:name", (c) => {
    const name = c.req.param("name");
    if (c.var.secrets.secret(name) === null) return c.json({ error: "That's gone." }, 404);
    c.var.secrets.setSecret(name, null);
    return c.json({ ok: true });
  });
