import { API_PREFIX, type Health } from "@hatbot/shared";
import { Hono } from "hono";

export const VERSION = "0.0.0";

export function createApp() {
  const app = new Hono().basePath(API_PREFIX);

  app.get("/health", (c) => c.json<Health>({ ok: true, version: VERSION }));

  return app;
}
