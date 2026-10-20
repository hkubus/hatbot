// Claude Code in the sandbox, on the owner's subscription: the claude_code tool in a task.
import { expect, test } from "bun:test";
import type { ShellJob } from "@hatbot/shared/desktop";
import { FakeModel, toolUse } from "./fake-model";
import { lastUserText, type TestApp, testApp } from "./helpers";

const TOKEN = "sk-ant-oat01-subscription-token";

/** What `claude -p --output-format stream-json` prints for a run that edits a file. */
const printed = (result: string, file: string) =>
  [
    { type: "system", subtype: "init", session_id: "s-1" },
    {
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: file } }] },
    },
    {
      type: "rate_limit_event",
      rate_limit_info: {
        unifiedWindows: { five_hour: { utilization: 0.26 }, seven_day: { utilization: 0.43 } },
      },
    },
    {
      type: "result",
      subtype: "success",
      is_error: false,
      result,
      session_id: "s-1",
      num_turns: 12,
      total_cost_usd: 0.8,
      duration_ms: 240_000,
    },
  ]
    .map((l) => `${JSON.stringify(l)}\n`)
    .join("");

async function withClaude(t: TestApp) {
  await t.plugins.setSecrets("claude", { CLAUDE_CODE_OAUTH_TOKEN: TOKEN });
  await t.plugins.update("claude", { enabled: true });
}

const argOf = (job: ShellJob | undefined, flag: string) => job?.argv[job.argv.indexOf(flag) + 1];

test("a task hands code work to Claude Code in the sandbox, its token kept out of the command, and reads what it did", async () => {
  const work = new FakeModel([
    { content: [toolUse("claude_code", { dir: "repos/app", request: "Fix the failing test." })] },
    { content: [toolUse("finish_task", { outcome: "done", summary: "Fixed.", notify: true })] },
  ]);
  const t = await testApp(new FakeModel(), work);
  await withClaude(t);
  t.agent.shell = (c) => ({
    exitCode: 0,
    output: c.startsWith("cd --") ? " M src/x.ts\n" : "",
    timedOut: false,
  });
  t.agent.runJob = () =>
    printed("Fixed the off-by-one in x.ts.", "/home/sandbox/repos/app/src/x.ts");
  const task = t.tasks.createBackgroundTask({ title: "Fix", goal: "Fix it.", origin: "schedule" });
  await t.tasks.idle();
  expect(t.tasks.get(task?.id ?? 0)?.status).toBe("done");

  const [job] = t.agent.jobs;
  expect(job?.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN);
  expect(job?.argv.join(" ")).not.toContain(TOKEN);
  expect(job).toMatchObject({ cwd: "repos/app", home: `.claude-runs/task-${task?.id}` });
  // Files and the shell, and nothing on the web.
  expect(argOf(job, "--tools")).toBe("Bash,Read,Edit,Write,Glob,Grep");
  const result = lastUserText(work.requests[1]);
  expect(result).toContain("Fixed the off-by-one");
  expect(result).toContain("5-hour 26%");
  expect(result).toContain("M src/x.ts");
  expect(t.events.some((e) => e.type === "task.progress" && e.text.includes("Edit src/x.ts"))).toBe(
    true,
  );
  // Its sessions in the sandbox go with the task.
  expect(t.agent.commands).toContain(`rm -rf -- '.claude-runs/task-${task?.id}'`);
});
