import { expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { UpdateInfo } from "@hatbot/shared";
import { setUpOwner, testApp } from "./helpers";

async function setup() {
  const t = await testApp();
  const { cookie } = await setUpOwner(t);
  const write = (name: string, body: unknown) =>
    writeFileSync(join(t.updateDir, name), JSON.stringify(body));
  const post = () => t.call("POST", "/update", undefined, { cookie });
  const get = async () =>
    (await (await t.call("GET", "/update", undefined, { cookie })).json()) as UpdateInfo;
  return { t, cookie, write, post, get };
}

test("the Update button is off until deploy.sh sets a source", async () => {
  const { post, get } = await setup();
  expect((await get()).source).toBeNull();
  expect((await post()).status).toBe(503);
});

test("asks hatbot-update by writing the request file, once at a time", async () => {
  const { t, write, post, get } = await setup();
  write("source.json", { url: "https://git.example/me/hatbot.git", branch: "main" });
  write("release.json", { sha: "abc", subject: "Old" });

  const res = await post();
  expect(res.status).toBe(202);
  expect(existsSync(join(t.updateDir, "request"))).toBe(true);
  expect((await get()).requested).toBe(true);
  expect((await post()).status).toBe(409);
});

test("waits while an update runs, but not on one that died long ago", async () => {
  const { write, post, t } = await setup();
  write("source.json", { url: "https://git.example/me/hatbot.git", branch: "main" });
  write("status.json", {
    state: "running",
    step: "Fetching",
    startedAt: "2026-10-09T11:59:00Z",
    notes: [],
  });
  expect((await post()).status).toBe(409);
  t.advance(60 * 60_000);
  expect((await post()).status).toBe(202);
});

test("won't restart the brain under a running task", async () => {
  const { write, post, t } = await setup();
  write("source.json", { url: "https://git.example/me/hatbot.git", branch: "main" });
  t.db.run(
    "INSERT INTO tasks (title, goal, origin, lane, model, status, budget_usd) VALUES ('x', 'x', 'chat', 'screen', 'm', 'running', 1)",
  );
  const res = await post();
  expect(res.status).toBe(409);
  expect(((await res.json()) as { error: string }).error).toMatch(/task is running/);
});

test("Check everything warns while Update deploys commits nobody signed", async () => {
  const { t, write, get } = await setup();
  const check = async () =>
    (await t.checks.run()).results.find((r) => r.id === "updates") as {
      state: string;
      detail: string;
    };
  write("source.json", { url: "https://git.example/me/hatbot.git", branch: "main", signed: false });
  expect((await get()).source).toEqual({
    url: "https://git.example/me/hatbot.git",
    branch: "main",
    signed: false,
  });
  const unsigned = await check();
  expect(unsigned.state).toBe("warn");
  expect(unsigned.detail).toContain("whoever can push to it can run code on the brain");
  write("source.json", { url: "https://git.example/me/hatbot.git", branch: "main", signed: true });
  expect((await check()).state).toBe("ok");
  // An older brain-deploy.sh doesn't say, which isn't taken for either.
  write("source.json", { url: "https://git.example/me/hatbot.git", branch: "main" });
  expect((await get()).source?.signed).toBeUndefined();
  expect((await check()).state).toBe("ok");
});
