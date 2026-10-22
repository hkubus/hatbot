// Claude Code in the sandbox, on the owner's subscription: the claude_code tool in a task, and boxes it
// makes for the chat (box_claude).
import { expect, test } from "bun:test";
import type { ShellJob } from "@hatbot/shared/desktop";
import { FakeModel, text, toolUse } from "./fake-model";
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
  expect(argOf(job, "--tools")).toBe("Bash,Read,Edit,Write,Glob,Grep");
  const result = lastUserText(work.requests[1]);
  expect(result).toContain("Fixed the off-by-one");
  expect(result).toContain("5-hour 26%");
  expect(result).toContain("M src/x.ts");
  expect(t.events.some((e) => e.type === "task.progress" && e.text.includes("Edit src/x.ts"))).toBe(
    true,
  );
  expect(t.agent.commands).toContain(`rm -rf -- '.claude-runs/task-${task?.id}'`);
});

test("box_claude: Claude Code writes a box as a task under the reply, a failed build goes back to it, and the bot hears", async () => {
  const chat = new FakeModel([
    {
      content: [
        toolUse("box_claude", { title: "Habits", request: "A habit tracker with streaks." }),
      ],
    },
    { content: [text("Claude Code is on it.")] },
    { content: [text("Here it is.")] },
  ]);
  const t = await testApp(chat);
  await withClaude(t);
  const files = new TextEncoder();
  t.agent.runJob = (job) => {
    t.agent.files.set(
      `${job.cwd}/index.html`,
      files.encode('<!doctype html><script type="module" src="./app.ts"></script>'),
    );
    t.agent.files.set(`${job.cwd}/app.ts`, files.encode("document.body.append('streaks');"));
    return printed("Made it.", `/home/sandbox/${job.cwd}/app.ts`);
  };
  // The sandbox lists what's in a box's folder.
  t.agent.shell = (c) => {
    const dir = c.startsWith("python3") && c.match(/'(boxes\/task-\d+)'$/)?.[1];
    const found = [...t.agent.files].filter(([p]) => dir && p.startsWith(`${dir}/`));
    return {
      exitCode: 0,
      output: dir ? JSON.stringify(found.map(([p, b]) => [p.slice(dir.length + 1), b.length])) : "",
      timedOut: false,
    };
  };
  t.hatbox.failBuild = 'error: Could not resolve "left-pad"';
  t.thread.post("make me a habit tracker");
  await t.thread.idle();
  await t.tasks.idle();
  await t.thread.idle();

  const [task] = t.tasks.list();
  const [box] = t.boxes.list();
  // Files only: nothing it writes runs in the sandbox.
  expect(argOf(t.agent.jobs[0], "--tools")).toBe("Read,Write,Edit,Glob,Grep");
  // The failed build's output went back to the same session, and tainted the task and the box.
  expect(t.agent.jobs).toHaveLength(2);
  expect(argOf(t.agent.jobs[1], "--resume")).toBe("s-1");
  expect(argOf(t.agent.jobs[1], "-p")).toContain("left-pad");
  expect(task).toMatchObject({ status: "done", tainted: true });
  expect(t.boxes.taintedBy(box?.id ?? 0)).not.toBeNull();
  expect(t.boxes.page(box?.id ?? 0)?.files?.map((f) => f.path)).toEqual(["app.ts", "index.html"]);
  const reply = t.db
    .query<{ box_id: number | null }, [number]>("SELECT box_id FROM messages WHERE task_id = ?")
    .get(task?.id ?? 0);
  expect(reply?.box_id).toBe(box?.id ?? -1);
  expect(JSON.stringify(chat.requests[2]?.messages)).toContain(`box #${box?.id}`);
  expect(t.agent.commands).toContain(`rm -rf -- 'boxes/task-${task?.id}'`);
});
