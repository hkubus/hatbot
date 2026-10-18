import { expect, test } from "bun:test";
import { ORIGIN, signIn, testApp } from "./helpers";

test("a malformed body is 400, and a wrong field says which, in every route group", async () => {
  const t = await testApp();
  const { cookie } = signIn(t);
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
  ] as const)
    expect((await raw(method, path, "{nope")).status).toBe(400);
  // The web app marks the field.
  const res = await t.call("PUT", "/memory/file?path=a.md", { content: 5 }, { cookie });
  expect(res.status).toBe(400);
  expect(await res.json()).toMatchObject({ field: "content" });
  const bad = await t.call("GET", "/memory/file", undefined, { cookie });
  expect(await bad.json()).toMatchObject({ field: "path" });
});
