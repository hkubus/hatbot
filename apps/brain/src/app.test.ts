import { expect, test } from "bun:test";
import { API_PREFIX } from "@hatbot/shared";
import { createApp, VERSION } from "./app";

test("health reports ok and the version", async () => {
  const res = await createApp().request(`${API_PREFIX}/health`);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, version: VERSION });
});

test("unknown routes are 404", async () => {
  const res = await createApp().request(`${API_PREFIX}/nope`);
  expect(res.status).toBe(404);
});
