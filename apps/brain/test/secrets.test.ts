import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runPluginTool, verdictFor } from "../src/plugins/registry";
import { FakeModel, text, toolUse } from "./fake-model";
import { signIn, type TestApp, testApp, waitFor } from "./helpers";
import { call, ended, finish, realSandbox, scheduled, tainted, toolOf } from "./plugin-helpers";

const TOKEN = "gta_9f8e7d6c5b4a";

async function withSandbox(chat = new FakeModel(), work = new FakeModel()) {
  const t = await testApp(chat, work);
  await t.plugins.update("code", { enabled: true });
  return { t, box: realSandbox(t) };
}

const asked = (t: TestApp) => waitFor(() => t.approvals.list(true)[0]);

test("a secret asked for in the chat is typed into the approval, kept out of the database and the model, and written into a file", async () => {
  const chat = new FakeModel([
    { content: [toolUse("secrets_ask", { name: "GITEA_TOKEN", why: "For the runner's .env" })] },
    {
      content: [
        toolUse("code_write_file", { path: "app/.env", content: "TOKEN={{secret:GITEA_TOKEN}}\n" }),
      ],
    },
    { content: [toolUse("code_run", { command: "cat app/.env" })] },
    { content: [text("Done.")] },
  ]);
  const { t, box } = await withSandbox(chat);
  const owner = signIn(t);
  const reply = t.thread.post("Set up the runner's token");
  const approval = await asked(t);
  expect(approval).toMatchObject({
    kind: "secret",
    secret: "GITEA_TOKEN",
    summary: "Type in GITEA_TOKEN",
    scopes: [],
  });
  const empty = await t.call("POST", `/approvals/${approval.id}`, { decision: "approve" }, owner);
  expect(empty.status).toBe(400);
  const typed = await t.call(
    "POST",
    `/approvals/${approval.id}`,
    { decision: "approve", secret: TOKEN },
    owner,
  );
  expect(typed.status).toBe(200);
  await reply.done;

  expect(readFileSync(join(box, "app/.env"), "utf8")).toBe(`TOKEN=${TOKEN}\n`);
  const seen = JSON.stringify(chat.requests);
  expect(seen).not.toContain(TOKEN);
  expect(seen).toContain("The owner typed it in.");
  // cat's output, as the model reads it.
  expect(seen).toContain("TOKEN={{secret:GITEA_TOKEN}}\\n");
  for (const table of ["approvals", "episode_turns", "task_steps", "messages"])
    expect(JSON.stringify(t.db.query(`SELECT * FROM ${table}`).all())).not.toContain(TOKEN);
});

test("a task's secret waits for the owner, who can't type it in from a notification; denied, the task is told", async () => {
  const ask = { content: [toolUse("secrets_ask", { name: "API_KEY", why: "For the script" })] };
  const work = new FakeModel([ask, finish(), ask, finish()]);
  const t = await testApp(new FakeModel(), work);
  const first = scheduled(t);
  const approval = await asked(t);
  expect(t.tasks.get(first.id)?.status).toBe("waiting_approval");
  expect(t.approvals.decide(approval.id, "approve", "ntfy")).toBeNull();
  const typed = await t.call(
    "POST",
    `/approvals/${approval.id}`,
    { decision: "approve", secret: TOKEN },
    signIn(t),
  );
  expect(typed.status).toBe(200);
  await ended(t, first.id);
  expect(JSON.stringify(work.requests[1]?.messages)).toContain("Write {{secret:API_KEY}}");
  expect(t.secrets.secret("API_KEY")).toBe(TOKEN);

  const second = scheduled(t);
  const again = await waitFor(() => t.approvals.list(true).find((a) => a.id !== approval.id));
  t.approvals.decide(again.id, "deny", "web");
  await ended(t, second.id);
  expect(JSON.stringify(work.requests[3]?.messages)).toContain("the owner said no");
  expect(t.secrets.secret("API_KEY")).toBe(TOKEN);
});

test("after untrusted content, putting a secret anywhere asks you, whatever Safety lets through", async () => {
  const { t } = await withSandbox();
  const write = toolOf(t, "code_write_file");
  const placing = { path: "a", content: "{{secret:API_KEY}}" };
  const mustAsk = { action: "ask", kind: "account_security", always: true, careful: true };
  expect(verdictFor(write, placing, call).action).toBe("allow");
  expect(verdictFor(write, placing, tainted)).toMatchObject(mustAsk);
  const lax = { tools: { code_write_file: "allow" as const }, untrusted: false };
  expect(verdictFor(write, placing, tainted, true, lax)).toMatchObject(mustAsk);
  expect(verdictFor(write, { path: "a", content: "x" }, tainted, true, lax).action).toBe("allow");
});

test("a secret that isn't kept isn't written", async () => {
  const { t, box } = await withSandbox();
  const r = await runPluginTool(
    toolOf(t, "code_write_file"),
    { path: "a.env", content: "X={{secret:NOPE}}" },
    call,
  );
  expect(r).toMatchObject({ isError: true, content: expect.stringContaining("NOPE") });
  expect(existsSync(join(box, "a.env"))).toBe(false);
});

test("what a tool says shows a kept secret as its placeholder, its errors too, but not one too short to hide", async () => {
  const { t } = await withSandbox();
  t.secrets.setSecret("API_KEY", TOKEN);
  t.secrets.setSecret("PIN", "1234");
  const run = (command: string) =>
    runPluginTool(toolOf(t, "code_run"), { command }, call, t.plugins.hideSecrets);
  const out = await run(`echo ${TOKEN}-${TOKEN}; echo 1234`);
  expect(out.text).toContain("{{secret:API_KEY}}-{{secret:API_KEY}}\n1234");
  const failed = await runPluginTool(
    toolOf(t, "code_write_file"),
    { path: "x", content: "{{secret:NOPE}}" },
    call,
    (s) => t.plugins.hideSecrets(s.replace("NOPE", TOKEN)),
  );
  expect(failed.content).not.toContain(TOKEN);
});

test("Settings → Secrets lists names without values, shows one when asked, and takes only a proper name", async () => {
  const t = await testApp();
  const owner = signIn(t);
  expect((await t.call("GET", "/secrets")).status).toBe(401);
  const bad = await t.call("PUT", "/secrets/api-key", { value: TOKEN }, owner);
  expect(bad.status).toBe(400);
  expect((await t.call("PUT", "/secrets/API_KEY", { value: TOKEN }, owner)).status).toBe(200);
  const listed = await (await t.call("GET", "/secrets", undefined, owner)).text();
  expect(listed).toContain("API_KEY");
  expect(listed).not.toContain(TOKEN);
  const shown = await t.call("POST", "/secrets/API_KEY/show", {}, owner);
  expect(await shown.json()).toEqual({ value: TOKEN });
  expect((await t.call("DELETE", "/secrets/API_KEY", undefined, owner)).status).toBe(200);
  expect(await (await t.call("GET", "/secrets", undefined, owner)).json()).toEqual([]);
  expect((await t.call("POST", "/secrets/API_KEY/show", {}, owner)).status).toBe(404);
});
