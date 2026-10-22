import { expect, test } from "bun:test";
import { statSync } from "node:fs";
import { signIn, testApp } from "./helpers";

test("the API key and ntfy set in Settings are tried, kept out of what the app reads, and in a file only the brain reads", async () => {
  const t = await testApp();
  const { cookie } = signIn(t);
  const key = "sk-ant-api03-0123456789abcdefWXYZ";

  const bad = await t.call("PUT", "/connections/anthropic", { key: `${key}bad` }, { cookie });
  expect(bad.status).toBe(400);
  expect(t.secrets.view().anthropic).toMatchObject({ from: "host", ending: "HOST" });

  const ok = await t.call("PUT", "/connections/anthropic", { key }, { cookie });
  expect(await ok.json()).toMatchObject({ anthropic: { set: true, from: "app", ending: "WXYZ" } });
  expect(t.secrets.apiKey()).toBe(key);

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
  expect(read).not.toContain(key);
  expect(read).not.toContain("tk_secret");
  expect(JSON.parse(read).ntfy).toMatchObject({ topic, tokenSet: true, from: "app" });
  expect(statSync(t.secrets.path).mode & 0o777).toBe(0o600);

  // Removed, the host's applies again.
  await t.call("DELETE", "/connections/anthropic", undefined, { cookie });
  expect(t.secrets.view().anthropic).toEqual({ set: true, from: "host", ending: "HOST" });
  expect((await t.call("GET", "/connections")).status).toBe(401);
});
