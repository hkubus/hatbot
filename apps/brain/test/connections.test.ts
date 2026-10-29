import { expect, test } from "bun:test";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Secrets } from "../src/secrets";
import { signIn, testApp } from "./helpers";

test("the ntfy server set in Settings is kept out of what the app reads, in a file only the brain reads", async () => {
  const t = await testApp();
  const { cookie } = signIn(t);

  // A topic anyone could guess would hand them the Approve buttons.
  const url = "https://ntfy.example.com/";
  const guessable = { url, topic: "hatbot", token: "tk_secret" };
  expect((await t.call("PUT", "/connections/ntfy", guessable, { cookie })).status).toBe(400);
  const topic = "hatbot-0123456789abcdef01234567";
  await t.call("PUT", "/connections/ntfy", { url, topic, token: "tk_secret" }, { cookie });
  // Left out, the token stays.
  await t.call("PUT", "/connections/ntfy", { url, topic }, { cookie });
  expect(t.secrets.ntfy()).toEqual({ url: "https://ntfy.example.com", topic, token: "tk_secret" });

  const read = await (await t.call("GET", "/connections", undefined, { cookie })).text();
  expect(read).not.toContain("tk_secret");
  expect(JSON.parse(read).ntfy).toMatchObject({ topic, tokenSet: true, from: "app" });
  expect(statSync(t.secrets.path).mode & 0o777).toBe(0o600);

  expect((await t.call("GET", "/connections")).status).toBe(401);
});

test("an API key set in Settings before providers were plugins is the Anthropic plugin's", () => {
  const path = join(mkdtempSync(join(tmpdir(), "hatbot-secrets-")), "secrets.json");
  writeFileSync(path, JSON.stringify({ anthropicApiKey: "sk-ant-old", env: { OTHER: "x" } }));
  expect(new Secrets(path, {}).pluginEnv()).toEqual({
    OTHER: "x",
    ANTHROPIC_API_KEY: "sk-ant-old",
  });
});
