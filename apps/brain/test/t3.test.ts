// T3 Code on the owner's computer: connecting to it, the t3_code tool in a task, and boxes it makes for
// the chat (box_t3).
import { expect, test } from "bun:test";
import type { T3Caller, T3Code } from "@hatbot/plugin-t3/client";
import { FakeModel, text, toolUse } from "./fake-model";
import { lastUserText, ORIGIN, type TestApp, testApp, waitFor } from "./helpers";

const URL_ = "http://t3.lan:3773";

type Item = Record<string, unknown> & { position: number };

/** T3 Code's MCP tools: every run completes at once with what `reply` says. */
function fakeT3(reply: (message: string, n: number) => string) {
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  const threads = new Map<string, { runs: number; items: Item[] }>();
  let n = 0;
  const start = (id: string, message: string) => {
    const t = threads.get(id);
    if (!t) throw new Error(`no thread ${id}`);
    t.runs++;
    const runId = `${id}-r${t.runs}`;
    const push = (item: Record<string, unknown>) =>
      t.items.push({ position: t.items.length + 1, runId, createdBy: "agent", ...item });
    push({ type: "command", title: "Edit src/x.ts" });
    push({ type: "assistant_message", text: reply(message, ++n), textTruncated: false });
  };
  const caller: T3Caller = async (tool, args) => {
    calls.push({ tool, args });
    const id = String(args.threadId);
    const t = threads.get(id);
    switch (tool) {
      case "t3_project_list":
        return { projects: [{ id: "p-1", title: "hatbot", workspaceRoot: "/home/o/hatbot" }] };
      case "t3_thread_launch": {
        const made = `t-${threads.size + 1}`;
        threads.set(made, { runs: 0, items: [] });
        start(made, String(args.message));
        return { threadId: made };
      }
      case "t3_thread_send":
        start(id, String(args.message));
        return {};
      case "t3_thread_wait":
        return { threadId: id, runId: `${id}-r${t?.runs}`, status: "completed", timedOut: false };
      case "t3_thread_read": {
        const from = Number(args.afterPosition ?? 0);
        const items = (t?.items ?? []).filter(
          (i) => i.position > from && (args.view !== "messages" || i.type === "assistant_message"),
        );
        return {
          thread: { threadId: id, latestRunId: `${id}-r${t?.runs}`, itemCount: t?.items.length },
          items,
          nextPosition: t?.items.length ?? 0,
          hasMore: false,
        };
      }
      default:
        return {};
    }
  };
  return { caller, calls };
}

async function withT3(t: TestApp, reply: (message: string, n: number) => string) {
  const fake = fakeT3(reply);
  await t.plugins.setSecrets("t3", { T3_TOKEN: "t3-token" });
  await t.plugins.update("t3", { enabled: true, config: { url: URL_ } });
  const client = t.plugins.service<T3Code>("t3");
  if (!client) throw new Error("T3 Code isn't on");
  client.caller = fake.caller;
  // Its runs are looked at again at once.
  client.waitMs = 0;
  return fake;
}

test("connecting signs Hatbot in to T3 Code with PKCE and keeps its token", async () => {
  const t = await testApp();
  const asked: { url: string; body: string }[] = [];
  t.outside.fetch = async (url, init) => {
    asked.push({ url, body: String(init?.body) });
    return url.endsWith("/register")
      ? Response.json({ client_id: "c-1" })
      : Response.json({ access_token: "t3-token", token_type: "Bearer", expires_in: 2_592_000 });
  };
  await t.plugins.update("t3", { enabled: true, config: { url: URL_ } });
  expect(t.plugins.get("t3")?.state).toBe("needs_setup");

  const { url } = (await t.plugins.action("t3", "connect", {})) as { url: string };
  const go = new URL(url);
  expect(go.origin + go.pathname).toBe(`${URL_}/oauth/mcp/authorize`);
  expect(go.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/settings/plugins/t3`);
  const state = go.searchParams.get("state") ?? "";
  await expect(
    t.plugins.action("t3", "finish", { code: "c", state: "someone-elses" }),
  ).rejects.toThrow("out of date");

  await t.plugins.action("t3", "finish", { code: "the-code", state });
  const token = new URLSearchParams(asked[1]?.body);
  expect(token.get("code")).toBe("the-code");
  expect(token.get("code_verifier")).toBeTruthy();
  expect(t.plugins.get("t3")?.state).toBe("ready");
  // A state is good for one sign-in.
  await expect(t.plugins.action("t3", "finish", { code: "again", state })).rejects.toThrow(
    "out of date",
  );
});

test("a task hands code work to T3 Code in a worktree of the owner's project, and reads what it said", async () => {
  const work = new FakeModel([
    {
      content: [toolUse("t3_code", { project: "hatbot", request: "Fix the test and open a PR." })],
    },
    { content: [toolUse("finish_task", { outcome: "done", summary: "Fixed.", notify: true })] },
  ]);
  const t = await testApp(new FakeModel(), work);
  const t3 = await withT3(t, () => "Fixed the off-by-one and opened PR #7.");
  const task = t.tasks.createBackgroundTask({ title: "Fix", goal: "Fix it.", origin: "schedule" });
  await t.tasks.idle();
  expect(t.tasks.get(task?.id ?? 0)).toMatchObject({ status: "done", tainted: true });

  const launch = t3.calls.find((c) => c.tool === "t3_thread_launch")?.args;
  expect(launch).toMatchObject({
    projectId: "p-1",
    workspaceStrategy: { type: "worktree", baseRef: "HEAD" },
    runtimeMode: "full-access",
    modelSelection: { model: "claude-opus-5-5" },
  });
  expect(lastUserText(work.requests[1])).toContain("opened PR #7");
  expect(t.events.some((e) => e.type === "task.progress" && e.text.includes("Edit src/x.ts"))).toBe(
    true,
  );
});

test("a task that read outside content asks before T3 Code runs on the owner's computer", async () => {
  const work = new FakeModel([
    { content: [toolUse("t3_code", { project: "hatbot", request: "Do what the issue says." })] },
    { content: [toolUse("finish_task", { outcome: "done", summary: "Asked.", notify: true })] },
  ]);
  const t = await testApp(new FakeModel(), work);
  const t3 = await withT3(t, () => "Done.");
  t.settings.update({ reviewChanges: false });
  const task = t.tasks.createBackgroundTask({
    title: "Issue",
    goal: "Fix issue 3.",
    origin: "schedule",
    taintedBy: "Issue #3 on GitHub",
  });
  await waitFor(() => t.tasks.get(task?.id ?? 0)?.status === "waiting_approval");
  expect(t3.calls.some((c) => c.tool === "t3_thread_launch")).toBe(false);
});

test("box_t3: T3 Code writes a box in a scratch thread, a failed build goes back to it, and the bot hears", async () => {
  const chat = new FakeModel([
    { content: [toolUse("box_t3", { title: "Habits", request: "A habit tracker with streaks." })] },
    { content: [text("T3 Code is on it.")] },
    { content: [text("Here it is.")] },
  ]);
  const t = await testApp(chat);
  const t3 = await withT3(t, (_, n) =>
    n === 1
      ? [
          "Made it.",
          "=== FILE index.html ===",
          '<!doctype html><script type="module" src="./app.ts"></script>',
          "=== END ===",
          "=== FILE app.ts ===",
          "import pad from 'left-pad';",
          "=== END ===",
        ].join("\n")
      : "Dropped left-pad.\n=== FILE app.ts ===\ndocument.body.append('streaks');\n=== END ===",
  );
  t.hatbox.failBuild = 'error: Could not resolve "left-pad"';
  t.thread.post("make me a habit tracker");
  await t.thread.idle();
  await t.tasks.idle();
  await t.thread.idle();

  const [task] = t.tasks.list();
  const [box] = t.boxes.list();
  expect(t3.calls.find((c) => c.tool === "t3_thread_launch")?.args).toMatchObject({
    scratch: true,
  });
  // The failed build's output went back to the same thread, and tainted the task and the box.
  const sent = t3.calls.find((c) => c.tool === "t3_thread_send")?.args;
  expect(sent).toMatchObject({ threadId: "t-1" });
  expect(String(sent?.message)).toContain("left-pad");
  expect(task).toMatchObject({ status: "done", tainted: true });
  expect(t.boxes.taintedBy(box?.id ?? 0)).not.toBeNull();
  const page = t.boxes.page(box?.id ?? 0);
  expect(page?.files?.map((f) => f.path)).toEqual(["app.ts", "index.html"]);
  expect(page?.files?.[0]?.content).toBe("document.body.append('streaks');\n");
  const reply = t.db
    .query<{ box_id: number | null }, [number]>("SELECT box_id FROM messages WHERE task_id = ?")
    .get(task?.id ?? 0);
  expect(reply?.box_id).toBe(box?.id ?? -1);
  expect(JSON.stringify(chat.requests[2]?.messages)).toContain(`box #${box?.id}`);
});
