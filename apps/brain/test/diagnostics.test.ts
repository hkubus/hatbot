import { expect, test } from "bun:test";
import type { Task } from "@hatbot/shared";
import { FakeModel, text, toolUse } from "./fake-model";
import { signIn, type TestApp, testApp } from "./helpers";

type Line = Record<string, unknown> & { type: string };

async function exported(t: TestApp) {
  const res = await t.call("GET", "/diagnostics/export", undefined, signIn(t));
  expect(res.status).toBe(200);
  const raw = new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await res.arrayBuffer())));
  return {
    res,
    raw,
    lines: raw
      .trimEnd()
      .split("\n")
      .map((l) => JSON.parse(l) as Line),
  };
}

test("the export for improving Hatbot has the chats, tasks with their steps and turns, and approvals, but no incognito or screenshots", async () => {
  const t = await testApp(
    new FakeModel([{ content: [text("Hi.")] }, { content: [text("Shh.")] }]),
    new FakeModel([
      {
        content: [
          toolUse("finish_task", { outcome: "failed", summary: "It didn't load.", notify: false }),
        ],
      },
    ]),
  );
  await t.thread.post("hello").done;
  await t.thread.post("between us", [], true).done;
  const task = t.tasks.createBackgroundTask({
    title: "Check the router",
    goal: "Check it",
    origin: "chat",
  }) as Task;
  await t.tasks.idle();
  const screenshot = "iVBORw0KGgo".repeat(100);
  t.tasks.appendTurn(task.id, "user", [
    { type: "image", source: { type: "base64", media_type: "image/png", data: screenshot } },
  ]);
  const asked = t.approvals.create({ taskId: task.id, kind: "budget", summary: "Raise it" });
  t.approvals.decide(asked.id, "deny", "web", "Too much");

  const { res, raw, lines } = await exported(t);
  expect(res.headers.get("content-disposition")).toMatch(
    /^attachment; filename="hatbot-diagnostics-\d{4}-\d\d-\d\d\.jsonl\.gz"$/,
  );
  expect(lines[0]?.type).toBe("export");
  const messages = lines.filter((l) => l.type === "message").map((l) => l.text);
  expect(messages).toEqual(["hello", "Hi.", expect.stringContaining("Check the router")]);
  expect(raw).not.toContain("between us");
  expect(raw).not.toContain("Shh.");
  expect(raw).not.toContain(screenshot);

  const exportedTask = lines.find((l) => l.type === "task") as Line & { turns: { role: string }[] };
  expect(exportedTask).toMatchObject({ id: task.id, status: "failed", summary: "It didn't load." });
  expect(exportedTask.turns.map((r) => r.role)).toEqual(["user", "assistant", "user"]);
  expect(lines.find((l) => l.type === "approval")).toMatchObject({
    task_id: task.id,
    status: "denied",
    note: "Too much",
  });
});

test("the export hides every secret the brain knows wherever it shows, and leaves out triggers' own", async () => {
  const t = await testApp(
    new FakeModel(),
    new FakeModel([
      { content: [toolUse("finish_task", { outcome: "done", summary: "Read.", notify: false })] },
    ]),
  );
  t.secrets.setSecret("GITEA_TOKEN", "tok_abcdef123456");
  t.secrets.setPluginEnv({ DESKTOP_AGENT_TOKEN: "desk-token-123456" });
  const trigger = t.triggers.create({ name: "Deploys", kind: "webhook", prompt: "Look" });
  const task = t.tasks.createBackgroundTask({ title: "Read env", goal: "Read", origin: "chat" });
  await t.tasks.idle();
  t.tasks.appendTurn((task as Task).id, "user", [
    {
      type: "tool_result",
      tool_use_id: "toolu_1",
      content: `GITEA=tok_abcdef123456 DESKTOP=desk-token-123456 HOOK=${trigger.secret}`,
    },
  ]);

  const { raw } = await exported(t);
  expect(raw).toContain("GITEA={{secret:GITEA_TOKEN}}");
  expect(raw).not.toContain("tok_abcdef123456");
  expect(raw).not.toContain("desk-token-123456");
  expect(raw).not.toContain(trigger.secret);
});
