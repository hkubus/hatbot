import { expect, test } from "bun:test";
import { VERSION } from "../src/app";
import { testApp } from "./helpers";

test("health reports ok and the version", async () => {
  const res = await (await testApp()).call("GET", "/health");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, version: VERSION });
});

test("unknown routes are 404", async () => {
  expect((await (await testApp()).call("GET", "/nope")).status).toBe(404);
});
