import { expect, test } from "bun:test";
import { VERSION } from "../src/app";
import { ORIGIN, setUpOwner, testApp } from "./helpers";

test("health reports ok and the version", async () => {
  const res = await (await testApp()).call("GET", "/health");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, version: VERSION });
});

test("unknown routes are 404", async () => {
  expect((await (await testApp()).call("GET", "/nope")).status).toBe(404);
});

test("a malformed body is 400, and a wrong field says which, in every route group", async () => {
  const t = await testApp();
  const { cookie } = await setUpOwner(t);
  const raw = (method: string, path: string, body: string) =>
    t.app.request(`/api/v1${path}`, {
      method,
      headers: { "content-type": "application/json", origin: ORIGIN, cookie },
      body,
    });
  for (const [method, path] of [
    ["POST", "/schedules"],
    ["PUT", "/memory/file?path=a.md"],
    ["POST", "/teach/1/save"],
  ] as const) {
    const res = await raw(method, path, "{nope");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("Malformed JSON");
  }
  const res = await t.call("PUT", "/memory/file?path=a.md", { content: 5 }, { cookie });
  expect(res.status).toBe(400);
  expect(await res.json()).toMatchObject({ field: "content" });
  const bad = await t.call("GET", "/memory/file", undefined, { cookie });
  expect(bad.status).toBe(400);
  expect(await bad.json()).toMatchObject({ field: "path" });
});
