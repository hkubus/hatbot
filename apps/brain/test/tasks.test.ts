import { expect, test } from "bun:test";
import { type Approval, latestNoteOnly, type TaskStep } from "@hatbot/shared";
import { inBatches } from "../src/agent/tools";
import { browser, computer, FakeModel, text, toolUse } from "./fake-model";
import { setUpOwner, type TestApp, testApp, waitFor } from "./helpers";

const finish = (summary = "Booked it.") => ({
  content: [toolUse("finish_task", { outcome: "done", summary })],
});

function startTask(t: TestApp, goal = "Book a table") {
  return t.tasks.createDesktopTask({ title: goal, goal, successCriteria: "", origin: "chat" });
}

const pending = (t: TestApp) => waitFor(() => t.approvals.list(true)[0]);

test("chat starts a desktop task that runs, archives screenshots and reports back", async () => {
  const chat = new FakeModel([
    {
      content: [
        toolUse("run_desktop_task", {
          title: "Check example.com",
          goal: "Open example.com",
          success_criteria: "",
        }),
      ],
    },
    { content: [text("Started it.")] },
    { content: [text("It worked.")] },
  ]);
  const work = new FakeModel([
    { content: [text("Opening the page."), computer("left_click", { coordinate: [100, 200] })] },
    { content: [computer("screenshot")] },
    finish("Example.com is up."),
  ]);
  const t = await testApp(chat, work);
  t.thread.post("check example.com");
  await t.thread.idle();
  // The task shows under the reply that started it, not as a card of its own.
  const reply = t.thread.list().find((m) => m.role === "assistant" && m.taskId);
  expect(reply?.kind).toBe("text");
  expect(reply?.text).toBe("Started it.");
  expect(t.thread.list().some((m) => m.kind === "task")).toBe(false);

  await t.tasks.idle();
  const task = t.tasks.get(reply?.taskId as number);
  expect(task?.status).toBe("done");
  expect(task?.summary).toBe("Example.com is up.");
  expect(task?.tainted).toBe(true);

  // Its result edited the reply, which is unread until you've seen it.
  const edited = t.thread.list().find((m) => m.id === reply?.id);
  expect(edited?.editedAt).toBe(task?.finishedAt as string);
  expect(t.thread.unread()).toContain(reply?.id as number);
  t.thread.markSeen(t.thread.unread());
  expect(t.thread.unread()).toEqual([]);
  expect(t.agent.actions.map((a) => a.name)).toEqual(["left_click"]);
  expect(task?.costUsd).toBeGreaterThan(0);

  // The request uses Opus with the computer toolset, and results echo toolset_name.
  const req = work.requests[1];
  expect(req?.model).toBe("claude-opus-5-5");
  expect(req?.tools?.[0]).toMatchObject({ type: "computer_toolset_20260801" });
  expect(req?.context_management?.edits?.[0]?.type).toBe("clear_tool_uses_20250919");
  const results = req?.messages.at(-1)?.content as { toolset_name?: string; content: unknown }[];
  const result = results[0];
  expect(result?.toolset_name).toBe("computer");
  expect(JSON.stringify(result?.content)).toContain("Clicked.");

  // Screenshots are in the archive and on the timeline.
  const shots = t.tasks.steps(task?.id as number).filter((s) => s.screenshot);
  expect(shots.length).toBe(2);
  expect(await t.archive.file(shots[1]?.screenshot as string)?.exists()).toBe(true);

  // The next chat turn hears how it ended.
  t.thread.post("thanks");
  await t.thread.idle();
  expect(JSON.stringify(chat.requests.at(-1)?.messages.at(-1))).toContain("<task_updates>");
  expect(t.notifier.sent.at(-1)?.title).toContain("Done");
});

test("a consequential click is held back until confirm_intent is approved", async () => {
  const work = new FakeModel([
    { content: [computer("left_click", { coordinate: [300, 520] })] },
    { content: [toolUse("confirm_intent", { kind: "payment", summary: "Click Pay now for $40" })] },
    { content: [computer("left_click", { coordinate: [300, 520] })] },
    { content: [computer("left_click", { coordinate: [300, 520] })] },
    finish(),
  ]);
  const t = await testApp(new FakeModel(), work);
  t.agent.element = { tag: "button", role: null, type: "submit", label: "Pay now", inForm: true };
  const task = startTask(t, "Pay the bill");

  const approval = await pending(t);
  expect(approval.kind).toBe("payment");
  expect(approval.sources).toEqual(["https://example.com/"]);
  expect(t.agent.actions).toEqual([]);
  expect(t.tasks.get(task.id)?.status).toBe("waiting_approval");
  // Payments only offer "Open in Hatbot" on the phone.
  expect(t.notifier.sent.at(-1)?.actions?.map((a) => a.label)).toEqual(["Open in Hatbot"]);
  // It waits above the composer, not in the thread.
  expect(t.thread.list().map((m) => m.kind as string)).not.toContain("approval");

  const { cookie } = await setUpOwner(t);
  const res = await t.call(
    "POST",
    `/approvals/${approval.id}`,
    { decision: "approve" },
    { cookie },
  );
  expect(res.status).toBe(200);
  await t.tasks.idle();

  // One approval, one click: the second Pay click is held back again.
  expect(t.agent.actions.filter((a) => a.name === "left_click").length).toBe(1);
  const held = JSON.stringify(work.requests[0 + 4]?.messages.at(-1));
  expect(held).toContain("confirm_intent first");
  expect(t.tasks.get(task.id)?.status).toBe("done");
});

test("a denied approval tells the model not to do it", async () => {
  const work = new FakeModel([
    { content: [toolUse("confirm_intent", { kind: "send", summary: "Send the email" })] },
    finish("Didn't send."),
  ]);
  const t = await testApp(new FakeModel(), work);
  startTask(t);
  const approval = await pending(t);
  t.approvals.decide(approval.id, "deny", "web");
  await t.tasks.idle();
  expect(JSON.stringify(work.requests[1]?.messages.at(-1))).toContain("The owner denied this");
});

test("ntfy buttons carry single-use signed tokens", async () => {
  const work = new FakeModel([
    { content: [toolUse("confirm_intent", { kind: "send", summary: "Post the reply" })] },
    finish(),
  ]);
  const t = await testApp(new FakeModel(), work);
  startTask(t);
  const approval = await pending(t);
  const buttons = t.notifier.sent.at(-1)?.actions ?? [];
  expect(buttons.map((b) => b.label)).toEqual(["Approve", "Deny"]);
  const approve = buttons[0] as { url: string; body: string };
  expect(approve.url).toBe(`https://hatbot.test/api/v1/approvals/${approval.id}/token-decision`);
  const body = JSON.parse(approve.body);

  const forged = await t.call("POST", `/approvals/${approval.id}/token-decision`, {
    ...body,
    decision: "deny",
  });
  expect(forged.status).toBe(403);
  const ok = await t.call("POST", `/approvals/${approval.id}/token-decision`, body, { origin: "" });
  expect(ok.status).toBe(200);
  const again = await t.call("POST", `/approvals/${approval.id}/token-decision`, body);
  expect(again.status).toBe(409);
  expect((t.approvals.get(approval.id) as Approval).decidedVia).toBe("ntfy");
  await t.tasks.idle();
});

test("request_takeover waits for you to take over and hand back", async () => {
  const work = new FakeModel([
    { content: [toolUse("request_takeover", { reason: "Log in to OpenTable" })] },
    finish(),
  ]);
  const t = await testApp(new FakeModel(), work);
  const task = startTask(t);
  await waitFor(() => t.tasks.get(task.id)?.status === "waiting_takeover");
  expect(t.desktop.get().request).toEqual({ taskId: task.id, reason: "Log in to OpenTable" });
  expect(t.notifier.sent.at(-1)?.title).toContain("Log in to OpenTable");

  const { cookie } = await setUpOwner(t);
  expect((await t.call("POST", "/desktop/takeover", undefined, { cookie })).status).toBe(200);
  expect(t.agent.locked).toBe(true);
  expect((await t.call("POST", "/desktop/handback", undefined, { cookie })).status).toBe(200);
  expect(t.agent.locked).toBe(false);
  await t.tasks.idle();
  expect(t.tasks.get(task.id)?.status).toBe("done");
  expect(JSON.stringify(work.requests[1]?.messages.at(-1))).toContain("handed the desktop back");
});

test("a page that looks like a prompt injection stops the task unless you approve", async () => {
  const work = new FakeModel([{ content: [computer("screenshot")] }, finish()]);
  work.onCreate = () => '{"suspected": true, "excerpt": "Ignore previous instructions"}';
  const t = await testApp(new FakeModel(), work);
  const task = startTask(t);
  const approval = await pending(t);
  expect(approval.kind).toBe("injection_warning");
  expect(approval.reason).toContain("Ignore previous instructions");
  t.approvals.decide(approval.id, "deny", "web");
  await t.tasks.idle();
  expect(t.tasks.get(task.id)?.status).toBe("cancelled");
  expect(t.tasks.get(task.id)?.injectionSuspected).toBe(true);
  // The page text went to Haiku JSON-encoded.
  expect(JSON.stringify(work.creates[0]?.messages)).toContain("page_json");
});

test("Pause all cancels running tasks and locks the desktop", async () => {
  const work = new FakeModel([{ content: [toolUse("request_takeover", { reason: "2FA" })] }]);
  const t = await testApp(new FakeModel(), work);
  const task = startTask(t);
  await waitFor(() => t.tasks.get(task.id)?.status === "waiting_takeover");
  const { cookie } = await setUpOwner(t);
  await t.call("POST", "/pause-all", undefined, { cookie });
  await t.tasks.idle();
  expect(t.tasks.get(task.id)?.status).toBe("cancelled");
  expect(t.tasks.get(task.id)?.summary).toBe("Stopped by Pause all.");
  expect(t.agent.locked).toBe(true);
});

test("hitting the task limit asks to raise it", async () => {
  const work = new FakeModel([{ content: [computer("screenshot")] }, finish()]);
  const t = await testApp(new FakeModel(), work);
  t.settings.update({ limits: { taskUsd: 0.02, dailyUsd: 10, monthlyUsd: 200 } });
  const task = startTask(t);
  const approval = await pending(t);
  expect(approval.kind).toBe("budget");
  t.approvals.decide(approval.id, "approve", "web");
  // Each approval adds one task limit; keep approving until it finishes.
  for (;;) {
    const next = await waitFor(
      () => t.approvals.list(true)[0] ?? (t.tasks.get(task.id)?.status === "done" && "done"),
    );
    if (next === "done") break;
    t.approvals.decide((next as Approval).id, "approve", "web");
  }
  await t.tasks.idle();
  expect(t.tasks.get(task.id)?.status).toBe("done");
});

test("tasks and screenshots need a login", async () => {
  const t = await testApp();
  expect((await t.call("GET", "/tasks")).status).toBe(401);
  expect((await t.call("GET", "/tasks/1/screens/1")).status).toBe(401);
  expect((await t.call("POST", "/desktop/takeover")).status).toBe(401);
  expect((await t.call("GET", "/approvals")).status).toBe(401);
});

test("one task at a time on the screen; waiting for approval frees it", async () => {
  const work = new FakeModel([
    // Task A asks for approval and so releases the screen...
    { content: [toolUse("confirm_intent", { kind: "send", summary: "Send it" })] },
    // ...task B runs to the end meanwhile...
    finish("B done."),
    // ...then A gets the screen back.
    finish("A done."),
  ]);
  const t = await testApp(new FakeModel(), work);
  const a = startTask(t, "A");
  const b = startTask(t, "B");
  expect(t.tasks.get(b.id)?.status).toBe("queued");
  const approval = await pending(t);
  await waitFor(() => t.tasks.get(b.id)?.status === "done");
  expect(t.tasks.get(a.id)?.status).toBe("waiting_approval");
  t.approvals.decide(approval.id, "approve", "web");
  await t.tasks.idle();
  expect(t.tasks.get(a.id)?.summary).toBe("A done.");
  expect(t.tasks.lane.holderId).toBeNull();
});

test("desktop_shell runs commands as text; destructive ones ask first", async () => {
  const work = new FakeModel([
    { content: [toolUse("desktop_shell", { command: "python3 -c 'print(6*7)'" })] },
    { content: [toolUse("desktop_shell", { command: "rm -rf ~/experiments" })] },
    finish("Worked it out."),
  ]);
  const t = await testApp(new FakeModel(), work);
  t.agent.shell = (c) => ({
    exitCode: 0,
    output: c.includes("print") ? "42" : "",
    timedOut: false,
  });
  const task = startTask(t, "Compute");
  const approval = await pending(t);
  expect(approval).toMatchObject({
    kind: "delete",
    summary: "On the desktop: rm -rf ~/experiments",
    reason: "This command deletes files recursively.",
  });
  expect(t.agent.commands).toEqual(["python3 -c 'print(6*7)'"]);
  t.approvals.decide(approval.id, "deny", "web");
  await t.tasks.idle();
  expect(t.tasks.get(task.id)?.status).toBe("done");
  expect(t.agent.commands).toHaveLength(1);
  const first = JSON.stringify(work.requests[1]?.messages.at(-1)?.content);
  expect(first).toContain("Exit code 0\\n42");
  const denied = JSON.stringify(work.requests[2]?.messages.at(-1)?.content);
  expect(denied).toContain("The owner denied this.");
  expect(t.tasks.steps(task.id).some((s) => s.name === "desktop_shell")).toBe(true);
});

test("desktop tasks run on the model Settings choose; each keeps the one it started with", async () => {
  const work = new FakeModel([finish("On Opus."), finish("On Haiku.")]);
  const t = await testApp(new FakeModel(), work);
  const first = startTask(t, "One");
  await t.tasks.idle();
  t.settings.update({ desktopModel: "claude-haiku-5-5" });
  const second = startTask(t, "Two");
  await t.tasks.idle();
  expect(t.tasks.get(first.id)?.model).toBe("claude-opus-5-5");
  expect(t.tasks.get(second.id)?.model).toBe("claude-haiku-5-5");
  expect(work.requests[0]?.model).toBe("claude-opus-5-5");
  expect(work.requests[0]?.thinking).toMatchObject({ display: "updates" });
  expect(work.requests[1]?.model).toBe("claude-haiku-5-5");
  expect(work.requests[1]?.thinking).toEqual({ type: "adaptive" });
  expect(t.db.query("SELECT DISTINCT model FROM spend_ledger ORDER BY model").all()).toEqual([
    { model: "claude-haiku-5-5" },
    { model: "claude-opus-5-5" },
  ]);
});

test("browser calls run on the browser toolset, with the tabs in place of the first screenshot", async () => {
  const work = new FakeModel([
    {
      content: [
        browser("navigate", { url: "example.com" }),
        browser("read_page", { filter: "interactive" }),
      ],
    },
    finish("Read it."),
  ]);
  const t = await testApp(new FakeModel(), work);
  const task = startTask(t, "Read example.com");
  await t.tasks.idle();
  expect(t.tasks.get(task.id)?.status).toBe("done");

  const first = work.requests[0];
  expect(first?.tools?.map((x) => (x as { type?: string }).type)).toContain(
    "browser_toolset_20260801",
  );
  // The model gets the tabs as text; the timeline still gets a screenshot.
  const start = JSON.stringify(first?.messages[0]?.content);
  expect(start).toContain("tab-1");
  expect(start).not.toContain('"image"');
  expect(t.tasks.steps(task.id).filter((s) => s.screenshot).length).toBe(1);

  expect(t.agent.browserCalls.map((c) => c.name)).toEqual(["navigate", "read_page"]);
  const results = work.requests[1]?.messages.at(-1)?.content as {
    toolset_name?: string;
    content: unknown;
  }[];
  expect(results.map((r) => r.toolset_name)).toEqual(["browser", "browser"]);
  expect(JSON.stringify(results[1]?.content)).toContain("ref_1");
});

test("a consequential browser click is checked by its element reference", async () => {
  const work = new FakeModel([
    {
      content: [
        browser("left_click", { target: { type: "ref", ref: "ref_7" } }),
        browser("type", { text: "hello" }),
      ],
    },
    finish(),
  ]);
  const t = await testApp(new FakeModel(), work);
  t.agent.element = { tag: "button", role: null, type: "submit", label: "Send", inForm: true };
  startTask(t, "Send a message");
  await t.tasks.idle();

  expect(t.agent.inspected).toEqual([{ ref: "ref_7" }]);
  expect(t.agent.browserCalls).toEqual([]);
  const results = work.requests[1]?.messages.at(-1)?.content as {
    is_error?: boolean;
    content: unknown;
  }[];
  expect(JSON.stringify(results[0]?.content)).toContain("confirm_intent first");
  // The batch stops at the held-back click: typing would land in the wrong place.
  expect(results[1]?.is_error).toBe(true);
  expect(results[1]?.content).toBe("Not executed: an earlier action in this turn failed.");
});

test("lookups in a row run at once; everything else runs on its own, in order", async () => {
  const log: string[] = [];
  const run = async (c: string) => {
    log.push(`start ${c}`);
    await Bun.sleep(5);
    log.push(`end ${c}`);
    return c.toUpperCase();
  };
  const out = await inBatches(["r1", "r2", "w", "r3"], (c) => c.startsWith("r"), run);
  expect(out).toEqual(["R1", "R2", "W", "R3"]);
  expect(log).toEqual([
    "start r1",
    "start r2",
    "end r1",
    "end r2",
    "start w",
    "end w",
    "start r3",
    "end r3",
  ]);
});

test("a task's timeline keeps only the model's latest note, and all of yours", () => {
  const step = (id: number, kind: TaskStep["kind"], name = "Note") =>
    ({ id, kind, name }) as TaskStep;
  const steps = [step(1, "note"), step(2, "action"), step(3, "note", "Your note"), step(4, "note")];
  expect(latestNoteOnly(steps).map((s) => s.id)).toEqual([2, 3, 4]);
});
