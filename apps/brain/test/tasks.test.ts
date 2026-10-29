import { expect, test } from "bun:test";
import { type DesktopAgent, DesktopError, HttpDesktopAgent } from "@hatbot/plugin-desktop";
import type { Task, TaskStep } from "@hatbot/shared";
import type { AgentElement } from "@hatbot/shared/desktop";
import { REVIEW_PROMPT } from "../src/agent/prompt";
import { limits } from "../src/tasks/desktop-run";
import { browser, computer, FakeModel, text, toolUse } from "./fake-model";
import { bot, signIn, type TestApp, testApp, waitFor } from "./helpers";

const finish = (summary = "Booked it.") => ({
  content: [toolUse("finish_task", { outcome: "done", summary })],
});

function startTask(t: TestApp, goal = "Book a table") {
  return t.tasks.createDesktopTask({ title: goal, goal, successCriteria: "", origin: "chat" });
}

/** finish_task for a background task, which also says whether to notify. */
const done = (summary: string) => ({
  content: [toolUse("finish_task", { outcome: "done", summary, notify: false })],
});

const pending = (t: TestApp) => waitFor(() => t.approvals.list(true)[0]);

const lastText = (req: { messages: { content: unknown }[] } | undefined) =>
  JSON.stringify(req?.messages.at(-1)?.content);

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
  const reply = t.thread.list().find((m) => m.role === "assistant" && m.taskId);
  expect(reply?.text).toBe("Started it.");

  await t.tasks.idle();
  const task = t.tasks.get(reply?.taskId as number);
  expect(task).toMatchObject({ status: "done", summary: "Example.com is up.", tainted: true });
  expect(task?.costUsd).toBeGreaterThan(0);
  expect(work.requests[0]?.model).toBe("claude-haiku-5-5");
  expect(t.agent.actions.map((a) => a.name)).toEqual(["left_click"]);
  const shots = t.tasks.steps(task?.id as number).filter((s) => s.screenshot);
  expect(shots.length).toBe(2);
  expect(await t.archive.file(shots[1]?.screenshot as string)?.exists()).toBe(true);

  // A chat's card leaves out what only the task's page shows, and a live view asks for the steps it
  // lacks, with the latest action again while its screenshot may still come.
  const { cookie } = signIn(t);
  const get = async (path: string) => (await t.call("GET", path, undefined, { cookie })).json();
  const [card] = (await get(`/tasks?ids=${task?.id}&view=card`)) as Record<string, unknown>[];
  expect(card).toMatchObject({ id: task?.id, status: "done", summary: "Example.com is up." });
  expect(
    ["goal", "successCriteria", "payload", "costUsd", "steps"].filter((k) => k in (card ?? {})),
  ).toEqual([]);
  const all = t.tasks.steps(task?.id as number);
  const last = all.at(-1)?.id as number;
  const clicked = t.tasks.addStep(task?.id as number, {
    kind: "action",
    name: "left_click",
    detail: "",
    url: null,
  });
  const since = (after: number) =>
    get(`/tasks/${task?.id}?afterStep=${after}`).then((r) =>
      (r as { steps: TaskStep[] }).steps.map((s) => s.id),
    );
  expect(await since(all.at(-2)?.id as number)).toEqual([last, clicked.id]);
  expect(await since(clicked.id)).toEqual([clicked.id]);
  t.tasks.setStepScreenshot(clicked.id, "x.webp");
  expect(await since(clicked.id)).toEqual([]);

  // The chat hears how it ended and writes the reply that started it again, unread until seen.
  await t.thread.idle();
  const after = t.thread.list().filter((m) => m.role === "assistant");
  expect(after.map((m) => [m.id, m.text])).toEqual([[reply?.id as number, "It worked."]]);
  expect(t.thread.unread()).toContain(reply?.id as number);
});

test("a consequential click is held, with the rest of its turn, until confirm_intent is approved; one approval is one click", async () => {
  const pay = () => computer("left_click", { coordinate: [300, 520] });
  const work = new FakeModel([
    { content: [pay(), computer("type", { text: "hello" })] },
    { content: [toolUse("confirm_intent", { kind: "payment", summary: "Click Pay now for $40" })] },
    { content: [pay()] },
    { content: [pay()] },
    finish(),
  ]);
  const t = await testApp(new FakeModel(), work);
  t.agent.element = { tag: "button", role: null, type: "submit", label: "Pay now", inForm: true };
  const task = startTask(t, "Pay the bill");

  const approval = await pending(t);
  expect(approval.kind).toBe("payment");
  expect(t.agent.actions).toEqual([]);
  expect(t.tasks.get(task.id)?.status).toBe("waiting_approval");
  // Typing after a held click would land in the wrong place.
  const held = work.requests[1]?.messages.at(-1)?.content as { content: unknown }[];
  expect(JSON.stringify(held[0]?.content)).toContain("call confirm_intent first");
  expect(held[1]?.content).toContain("Not executed");

  t.approvals.decide(approval.id, "approve", "web");
  await t.tasks.idle();
  expect(t.agent.actions.map((a) => a.name)).toEqual(["left_click"]);
  expect(lastText(work.requests[4])).toContain("call confirm_intent first");
  expect(t.tasks.get(task.id)?.status).toBe("done");
});

test("a desktop task from a tainted chat or task starts tainted", async () => {
  const chat = new FakeModel([
    { content: [text("Noted.")] },
    {
      content: [
        toolUse("run_desktop_task", { title: "Do it", goal: "Act on it", success_criteria: "" }),
      ],
    },
    { content: [text("Started.")] },
    { content: [text("Done.")] },
  ]);
  const work = new FakeModel([
    { content: [toolUse("finish_task", { outcome: "done", summary: "ok", notify: false })] },
    finish("ok"),
    finish("ok"),
  ]);
  const t = await testApp(chat, work);
  const read = t.tasks.createBackgroundTask({
    title: "Read a PR",
    goal: "Read it",
    origin: "chat",
    taintedBy: "A web page",
  }) as Task;
  await t.tasks.idle();
  t.thread.post("ok");
  await t.thread.idle();
  t.thread.post("now do it");
  await t.thread.idle();
  const desk = t.tasks.list().find((x) => x.title === "Do it");
  expect(desk?.taintedBy).toBe(`The chat had read: Task #${read.id} "Read a PR"`);
  // One a tainted background task starts carries its mark.
  const child = t.tasks.createDesktopTask({
    title: "Child",
    goal: "Go on",
    successCriteria: "",
    origin: "chat",
    parent: t.tasks.get(read.id) as Task,
  });
  expect(child.taintedBy).toBe(`Task #${read.id}, which had read: A web page`);
  await t.tasks.idle();
  await t.thread.idle();
});

test("notification buttons carry signed, single-use tokens that do only their own thing", async () => {
  const work = new FakeModel([
    { content: [toolUse("confirm_intent", { kind: "send", summary: "Post the reply" })] },
    { content: [toolUse("request_takeover", { reason: "2FA" })] },
  ]);
  const t = await testApp(new FakeModel(), work);
  t.settings.update({ reviewChanges: false });
  const task = startTask(t);
  const approval = await pending(t);
  const [approve, , pause] = (t.notifier.sent.at(-1)?.actions ?? []) as {
    url: string;
    body: string;
  }[];
  expect(approve?.url).toBe(`https://hatbot.test/api/v1/approvals/${approval.id}/token-decision`);
  const yes = JSON.parse(approve?.body ?? "") as { decision: string; exp: number; sig: string };
  const stop = JSON.parse(pause?.body ?? "") as { exp: number; sig: string };
  const decide = (body: unknown, headers: Record<string, string> = {}) =>
    t.call("POST", `/approvals/${approval.id}/token-decision`, body, headers);

  // A forged decision, or Pause all's signature, doesn't decide; Approve's signature doesn't pause.
  expect((await decide({ ...yes, decision: "deny" })).status).toBe(403);
  expect((await decide({ decision: "approve", ...stop })).status).toBe(403);
  expect((await t.call("POST", "/pause-all/token", { ...stop, sig: yes.sig })).status).toBe(403);
  expect((await decide(yes, { origin: "" })).status).toBe(200);
  expect((await decide(yes)).status).toBe(409);
  expect(t.approvals.get(approval.id)?.decidedVia).toBe("ntfy");

  await waitFor(() => t.tasks.get(task.id)?.status === "waiting_takeover");
  expect((await t.call("POST", "/pause-all/token", stop, { origin: "" })).status).toBe(200);
  await t.tasks.idle();
  expect(t.settings.get().paused).toBe(true);
  expect(t.tasks.get(task.id)).toMatchObject({
    status: "cancelled",
    summary: "Stopped by Pause all.",
  });
  expect(t.agent.locked).toBe(true);
});

test("a budget raise can't be approved from a notification, only denied", async () => {
  const t = await testApp();
  const a = t.approvals.create({ taskId: null, kind: "budget", summary: "Raise it" });
  const n = await waitFor(() => t.notifier.sent.find((x) => x.title === "Approve: Raise it"));
  expect(n.actions?.map((b) => b.label)).toEqual(["Open in Hatbot", "Deny", "Pause all"]);
  // A signed Approve, as an older notification would carry, is refused, and so is decide().
  const exp = Math.floor(Date.parse(a.expiresAt) / 1000);
  const sig = t.approvals.sign(a.id, "approve", exp);
  const approve = await t.call("POST", `/approvals/${a.id}/token-decision`, {
    decision: "approve",
    exp,
    sig,
  });
  expect(approve.status).toBe(403);
  expect(t.approvals.decide(a.id, "approve", "ntfy")).toBeNull();
  const button = n.actions?.[1];
  const deny = JSON.parse(button?.action === "http" ? (button.body ?? "") : "");
  expect((await t.call("POST", `/approvals/${a.id}/token-decision`, deny)).status).toBe(200);
  expect(t.approvals.get(a.id)).toMatchObject({ status: "denied", decidedVia: "ntfy" });
});

test("an approval asked before trying covers only the step it names, once, on its page", async () => {
  const url = "https://mail.example/inbox/ann";
  const step = (label: string): AgentElement => ({
    tag: "button",
    role: null,
    type: "button",
    label,
    inForm: false,
    url,
    editable: false,
    fields: [],
  });
  const ask = () =>
    toolUse("confirm_intent", { kind: "send", summary: "Click Send to message Ann" });
  const send = () => computer("left_click", { coordinate: [300, 520] });
  const work = new FakeModel([
    { content: [ask()] },
    // Not the step approved: it asks, and the approval is spent.
    { content: [computer("left_click", { coordinate: [300, 100] })] },
    { content: [computer("type", { text: "ok" })] },
    { content: [ask()] },
    // The step it names runs, once.
    { content: [send()] },
    { content: [send()] },
    { content: [computer("type", { text: "ok" })] },
    { content: [ask()] },
    // It goes when the page changes, even if the model comes back.
    { content: [browser("navigate", { url: `${url}/sent` })] },
    { content: [browser("navigate", { url })] },
    { content: [send()] },
    finish(),
  ]);
  const t = await testApp(new FakeModel(), work);
  t.settings.update({ reviewChanges: false });
  t.agent.page = { url, title: "Ann", text: "" };
  t.agent.inspect = async (_x?: number, y?: number) => step(y === 100 ? "Delete account" : "Send");
  t.agent.afterAction = (name, input) => {
    if (name === "navigate") t.agent.page = { url: String(input.url), title: "Mail", text: "" };
  };
  startTask(t, "Write to Ann");
  for (let i = 0; i < 3; i++) t.approvals.decide((await pending(t)).id, "approve", "web");
  await t.tasks.idle();
  const said = (n: number) => lastText(work.requests[n]);
  expect(said(2)).toContain('not this step on \\"Delete account\\"');
  expect(said(5)).toContain("Clicked.");
  expect(said(6)).toContain('click \\"Send\\"');
  expect(said(11)).toContain('click \\"Send\\"');
  expect(t.agent.actions.filter((a) => a.name === "left_click")).toHaveLength(1);
});

test("a lock-screen approval for a message doesn't buy, and asking again needs the app", async () => {
  const url = "https://www.olx.pl/d/oferta/rower-CID1-ID77.html";
  const work = new FakeModel([
    {
      content: [
        toolUse("confirm_intent", { kind: "send", summary: "Ask the seller about the bike" }),
      ],
    },
    { content: [computer("left_click", { coordinate: [300, 520] })] },
    { content: [toolUse("confirm_intent", { kind: "send", summary: "Ask the seller again" })] },
    { content: [computer("left_click", { coordinate: [300, 520] })] },
    finish(),
  ]);
  const t = await testApp(new FakeModel(), work);
  t.settings.update({ reviewChanges: false });
  t.agent.page = { url, title: "Rower", text: "Rower. 500 zł. Kup teraz." };
  t.agent.element = {
    tag: "button",
    role: null,
    type: "button",
    label: "Kup teraz",
    inForm: false,
    url,
    editable: false,
    fields: [],
  };
  startTask(t, "Ask about the bike");
  const first = await pending(t);
  expect(first.kind).toBe("send");
  expect(t.approvals.decide(first.id, "approve", "ntfy")).not.toBeNull();
  // The click it was spent on buys: held again, and asking again is a purchase, for the app.
  const second = await pending(t);
  expect(lastText(work.requests[2])).toContain("wasn't for buying or paying");
  expect(second.kind).toBe("purchase");
  expect(second.reason).toContain('Hatbot held: left_click on "Kup teraz"');
  expect(t.notifier.sent.at(-1)?.actions?.[0]?.label).toBe("Open in Hatbot");
  expect(t.approvals.decide(second.id, "approve", "ntfy")).toBeNull();
  t.approvals.decide(second.id, "approve", "web");
  await t.tasks.idle();
  expect(t.agent.actions.filter((a) => a.name === "left_click")).toHaveLength(1);
});

test("an unanswered takeover leaves the screen to other tasks; Take over gives it back first", async () => {
  let done = () => {};
  const thinking = new Promise<void>((resolve) => {
    done = resolve;
  });
  const work = new FakeModel([
    // A meets a captcha at night and asks for you...
    { content: [toolUse("request_takeover", { reason: "Solve the captcha" })] },
    // ...B, an alert's task, runs meanwhile and is thinking when you take over...
    { content: [computer("left_click", { coordinate: [10, 10] })], wait: thinking },
    // ...A carries on once you hand back...
    finish("A done."),
    // ...and B looks again before it acts.
    finish("B done."),
  ]);
  const t = await testApp(new FakeModel(), work);
  const { cookie } = signIn(t);
  const a = startTask(t, "A");
  await waitFor(() => t.tasks.get(a.id)?.status === "waiting_takeover");
  expect(t.desktop.get().request).toEqual({ taskId: a.id, reason: "Solve the captcha" });
  expect(t.lane.holderId).toBeNull();
  const b = startTask(t, "B");
  await waitFor(() => work.requests.length === 2);
  expect(t.lane.holderId).toBe(b.id);

  expect((await t.call("POST", "/desktop/takeover", undefined, { cookie })).status).toBe(200);
  expect(t.lane.holderId).toBe(a.id);
  expect(t.agent.locked).toBe(true);
  done();
  await waitFor(() => t.tasks.get(b.id)?.status === "queued");
  expect((await t.call("POST", "/desktop/handback", undefined, { cookie })).status).toBe(200);
  expect(t.agent.locked).toBe(false);
  await t.tasks.idle();
  expect(t.tasks.get(a.id)?.summary).toBe("A done.");
  expect(t.tasks.get(b.id)?.summary).toBe("B done.");
  // B's click was planned on a screen that changed: it never ran.
  expect(t.agent.actions.filter((x) => x.name === "left_click")).toEqual([]);
  expect(t.desktop.get().request).toBeNull();
});

test("a task has no spending limit of its own: only today's and the month's", async () => {
  const work = new FakeModel([
    { content: [computer("screenshot")], usage: { input_tokens: 1_000_000 } },
    finish(),
  ]);
  const t = await testApp(new FakeModel(), work);
  t.settings.update({
    limits: { dailyUsd: 100, monthlyUsd: 200 },
    desktopModel: "claude-opus-5-5",
  });
  const task = startTask(t);
  await t.tasks.idle();
  expect(t.tasks.get(task.id)).toMatchObject({ status: "done" });
  expect(t.tasks.get(task.id)?.costUsd).toBeGreaterThan(3);
  expect(t.approvals.list(false)).toEqual([]);
});

test("desktop_shell runs commands as text; the review blocks a destructive one you didn't ask for", async () => {
  const work = new FakeModel([
    { content: [toolUse("desktop_shell", { command: "python3 -c 'print(6*7)'" })] },
    { content: [toolUse("desktop_shell", { command: "rm -rf ~/build" })] },
    { content: [toolUse("desktop_shell", { command: "rm -rf ~/experiments" })] },
    finish("Worked it out."),
  ]);
  const t = await testApp(new FakeModel(), work);
  t.agent.shell = (c) => ({
    exitCode: 0,
    output: c.includes("print") ? "42" : "",
    timedOut: false,
  });
  t.taskModel.onCreate = (p) =>
    p.system === REVIEW_PROMPT
      ? JSON.stringify(
          JSON.stringify(p.messages).includes("build")
            ? { safe: true, why: "Build output." }
            : { safe: false, why: "Nothing else has these files." },
        )
      : undefined;
  const task = startTask(t, "Compute");
  await t.tasks.idle();
  const [blocked] = t.approvals.list(false);
  expect(blocked).toMatchObject({
    status: "blocked",
    kind: "delete",
    summary: "On the desktop: rm -rf ~/experiments",
  });
  expect(blocked?.reason).toContain("Opus 5.5: Nothing else has these files.");
  expect(t.tasks.get(task.id)?.status).toBe("done");
  expect(t.agent.commands).toEqual(["python3 -c 'print(6*7)'", "rm -rf ~/build"]);
  expect(lastText(work.requests[1])).toContain("Exit code 0\\n42");
  expect(lastText(work.requests[3])).toContain("Blocked by the safety review");
  expect(t.approvals.list(false)).toHaveLength(1);
});

test("a click in a frame Hatbot can't enter, or that it couldn't look at, is held", async () => {
  const work = new FakeModel([
    // A PayU widget desktop-agent couldn't get into.
    { content: [browser("left_click", { target: { type: "coordinate", x: 60, y: 30 } })] },
    // The browser couldn't say what's at the point.
    { content: [browser("left_click", { target: { type: "ref", ref: "ref_9" } })] },
    // The screen's inspect failed on a page.
    { content: [computer("left_click", { coordinate: [60, 30] })] },
    // Off the page (the browser's own bar): nothing to check, so it runs.
    { content: [computer("left_click", { coordinate: [400, 10] })] },
    finish(),
  ]);
  const t = await testApp(new FakeModel(), work);
  const frame = { tag: "iframe", role: null, type: null, label: "PayU", inForm: false };
  const looks: (typeof frame | null)[] = [frame, null];
  t.agent.browserInspect = async () => looks.shift() ?? null;
  let screen = 0;
  t.agent.inspect = async () => {
    if (screen++ === 0) throw new DesktopError("The page script failed: timed out", 400);
    return null;
  };
  startTask(t, "Pay for the order");
  await t.tasks.idle();
  expect(lastText(work.requests[1])).toContain("lands in an embedded frame");
  expect(lastText(work.requests[2])).toContain("couldn't see what this click would act on");
  expect(lastText(work.requests[3])).toContain("couldn't see what this click would act on");
  expect(t.agent.browserCalls).toEqual([]);
  expect(t.agent.actions.map((a) => a.input)).toEqual([{ coordinate: [400, 10] }]);
});

test("each line break in typed text is checked on its own: one send the review approves sends one message", async () => {
  const work = new FakeModel([
    { content: [computer("type", { text: "Hi Ann" })] },
    { content: [computer("key", { text: "Return" })] },
    { content: [toolUse("confirm_intent", { kind: "send", summary: "Send Ann a hello" })] },
    { content: [computer("type", { text: "\nsecond message\nthird message\n" })] },
    finish(),
  ]);
  const t = await testApp(new FakeModel(), work);
  const url = "https://chat.example/c/1";
  t.agent.page = { url, title: "Ann", text: "" };
  t.agent.element = {
    tag: "textarea",
    role: null,
    type: null,
    label: "Message",
    inForm: false,
    url,
    editable: true,
    buttonsAfter: ["Send"],
  };
  t.taskModel.onCreate = (p) =>
    p.system === REVIEW_PROMPT
      ? JSON.stringify({ safe: true, why: "The owner asked to write to Ann." })
      : undefined;
  const task = startTask(t, "Write to Ann");
  await t.tasks.idle();
  // The approved Enter, then the text after it; the next Enter waits for another approval.
  expect(t.agent.actions.map((a) => a.input.text)).toEqual(["Hi Ann", "\n", "second message"]);
  expect(lastText(work.requests[4])).toContain('submit with \\"Send\\"');
  expect(t.tasks.steps(task.id).some((s) => s.name === "Not asking: Haiku 5.5 found it safe")).toBe(
    true,
  );
  expect(t.approvals.list(false)).toHaveLength(0);
});

test("a background task waits without a slot, wakes on an event, and can notify before it ends", async () => {
  const work = new FakeModel([
    {
      content: [
        toolUse("notify_owner", { message: "The backup started late." }),
        toolUse("wait", { minutes: 30, for: "the backup to finish" }),
      ],
    },
    {
      content: [
        toolUse("finish_task", { outcome: "done", summary: "Backup finished.", notify: false }),
      ],
    },
  ]);
  const t = await testApp(new FakeModel(), work);
  const task = t.tasks.createBackgroundTask({
    title: "Watch the backup",
    goal: "Tell me when the backup finishes",
    origin: "schedule",
    source: "nightly",
    runKey: "schedule:1",
  }) as Task;
  await waitFor(() => t.tasks.steps(task.id).find((s) => s.name === "wait"));
  // Waiting gives its slot back: every slot is free.
  const signal = AbortSignal.timeout(500);
  for (let i = 0; i < t.tasks.pool.size; i++) await t.tasks.pool.acquire(signal);
  for (let i = 0; i < t.tasks.pool.size; i++) t.tasks.pool.release();
  t.tasks.tell(task.id, "Backup job finished OK.");
  await t.tasks.idle();
  expect(t.tasks.get(task.id)?.summary).toBe("Backup finished.");
  expect(lastText(work.requests[1])).toContain("Backup job finished OK.");
  expect(t.notifier.sent.map((n) => n.message)).toEqual(["The backup started late."]);
});

test("a Haiku desktop task out of steps carries on, once, on Opus; one its budget stopped doesn't", async () => {
  const shot = { content: [computer("screenshot")] };
  const work = new FakeModel([shot, shot, shot, finish("Booked on Opus.")]);
  work.onCreate = (p) =>
    JSON.stringify(p.messages).includes("You were stopped")
      ? "I opened the booking page, but the date picker didn't take a click."
      : undefined;
  const t = await testApp(new FakeModel(), work);
  limits.maxSteps = 3;
  try {
    const task = startTask(t);
    await t.tasks.idle();
    expect(t.tasks.get(task.id)).toMatchObject({
      status: "done",
      summary: "Booked on Opus.",
      model: "claude-opus-5-5",
    });
    expect(work.requests.map((r) => r.model)).toEqual([
      "claude-haiku-5-5",
      "claude-haiku-5-5",
      "claude-haiku-5-5",
      "claude-opus-5-5",
    ]);
    // Opus starts afresh with Haiku's account of what it tried, as data.
    const opus = JSON.stringify(work.requests[3]?.messages);
    expect(work.requests[3]?.messages.length).toBe(1);
    expect(opus).toContain('<earlier_attempt trusted=\\"false\\">');
    expect(opus).toContain("the date picker didn't take a click");
  } finally {
    limits.maxSteps = 80;
  }

  // Today's limit is spent: Opus would only spend more.
  const broke = new FakeModel([]);
  const t2 = await testApp(new FakeModel(), broke);
  t2.settings.update({ limits: { dailyUsd: 0.0001, monthlyUsd: 200 } });
  const b = startTask(t2);
  await t2.tasks.idle();
  expect(t2.tasks.get(b.id)).toMatchObject({ status: "failed", model: "claude-haiku-5-5" });
  expect(broke.requests).toHaveLength(0);
});

test("cancelling a task cancels the desktop task it started, which then does nothing more", async () => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const work = new FakeModel();
  let parent = 0;
  work.route = (p) => {
    if (JSON.stringify(p.messages[0]).includes("Read the price"))
      return { content: [computer("left_click", { coordinate: [10, 10] })], wait: gate };
    return ++parent === 1
      ? {
          content: [
            toolUse("run_desktop_task", {
              title: "Look",
              goal: "Read the price",
              success_criteria: "",
            }),
          ],
        }
      : finish("Done.");
  };
  const t = await testApp(new FakeModel(), work);
  const task = t.tasks.createBackgroundTask({
    title: "Price",
    goal: "Find the price.",
    origin: "schedule",
  }) as Task;
  await waitFor(() => work.requests.length === 2);
  const child = t.tasks.list({}).find((x) => x.parentId === task.id) as Task;
  t.tasks.cancel(task.id);
  await waitFor(() => t.tasks.get(task.id)?.status === "cancelled");
  release();
  await t.tasks.idle();
  expect(t.tasks.get(child.id)?.status).toBe("cancelled");
  expect(t.agent.actions).toEqual([]);
});

test("cancelling a task stops its command in the sandbox", async () => {
  const work = new FakeModel([{ content: [toolUse("code_run", { command: "sleep 600" })] }]);
  const t = await testApp(new FakeModel(), work);
  await t.plugins.update("code", { enabled: true });
  let running = false;
  // The sandbox as the task's signal sees it: its command ends only when that aborts.
  (t.agent as DesktopAgent).withSignal = (signal) =>
    Object.assign(Object.create(t.agent), {
      exec: () => {
        running = true;
        return new Promise((_, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason)),
        );
      },
    });
  const task = t.tasks.createBackgroundTask({ title: "Run", goal: "Run it.", origin: "schedule" });
  await waitFor(() => running);
  t.tasks.cancel(task?.id ?? 0);
  await t.tasks.idle();
  expect(t.tasks.get(task?.id ?? 0)?.status).toBe("cancelled");
});

test("a desktop request in flight ends as soon as its task's signal aborts", async () => {
  let asked = false;
  const server = Bun.serve({
    port: 0,
    fetch: () => {
      asked = true;
      return new Promise<Response>(() => {});
    },
  });
  try {
    const stop = new AbortController();
    const agent = new HttpDesktopAgent(`http://localhost:${server.port}`, "token").withSignal(
      stop.signal,
    );
    const call = agent.action({ name: "wait", input: { duration: 5 } });
    await waitFor(() => asked);
    stop.abort(new Error("cancelled"));
    await expect(call).rejects.toThrow("cancelled");
  } finally {
    server.stop(true);
  }
});

test("a task whose reply hit the context window stops as failed, without running its calls", async () => {
  const work = new FakeModel([
    {
      content: [toolUse("memory_write", { path: "notes/z.md", content: "z" })],
      stop_reason: "model_context_window_exceeded",
    },
  ]);
  const t = await testApp(new FakeModel(), work);
  const task = t.tasks.createBackgroundTask({ title: "Long", goal: "Read it all", origin: "chat" });
  await t.tasks.idle();
  expect(t.tasks.get(task?.id ?? 0)?.status).toBe("failed");
  expect(await t.memory.exists("notes/z.md")).toBe(false);
});

test("an ended task runs again with its goal as you edited it, still tainted", async () => {
  const work = new FakeModel([
    { content: [toolUse("finish_task", { outcome: "done", summary: "First.", notify: false })] },
    { content: [toolUse("finish_task", { outcome: "done", summary: "Second.", notify: false })] },
  ]);
  const t = await testApp(new FakeModel(), work);
  const { cookie } = signIn(t);
  const first = t.tasks.createBackgroundTask({
    title: "Deploy",
    goal: "Deploy main",
    origin: "webhook",
    source: "Forgejo",
    payload: '{"ref":"main"}',
  }) as Task;
  await waitFor(() => t.tasks.get(first.id)?.finishedAt);
  const res = await t.call(
    "POST",
    `/tasks/${first.id}/rerun`,
    { goal: "Deploy main again" },
    { cookie },
  );
  expect(res.status).toBe(201);
  const again = (await res.json()) as Task;
  expect(again).toMatchObject({
    goal: "Deploy main again",
    payload: '{"ref":"main"}',
    tainted: true,
    taintedBy: "The event that started it (Forgejo)",
  });
  expect((await t.call("POST", `/tasks/${again.id}/rerun`, {}, { cookie })).status).toBe(409);
  await t.tasks.idle();
  expect(JSON.stringify(work.requests[1]?.messages)).toContain("Deploy main again");
});

test("the chat steers its running task: the note wakes it and comes with its next step, and the owner's words join its request", async () => {
  const chat = new FakeModel([
    { content: [toolUse("run_task", { title: "Buy filters", goal: "Order one water filter" })] },
    { content: [text("On it.")] },
  ]);
  const work = new FakeModel([
    { content: [toolUse("wait", { minutes: 30, for: "the shop to confirm" })] },
    done("Ordered two."),
  ]);
  const t = await testApp(chat, work);
  t.thread.post("order a water filter");
  await t.thread.idle();
  const task = t.tasks.list().find((x) => x.title === "Buy filters") as Task;
  await waitFor(() => t.tasks.steps(task.id).find((s) => s.name === "wait"));

  chat.script.push(
    { content: [toolUse("steer_task", { id: task.id, note: "Order two filters, not one." })] },
    { content: [text("Told it.")] },
    { content: [text("It ordered two.")] },
  );
  t.thread.post("make it two");
  await t.tasks.idle();
  expect(lastText(work.requests[1])).toContain(
    '<steer from=\\"chat\\">\\nOrder two filters, not one.\\n</steer>',
  );
  expect(t.tasks.steps(task.id).find((s) => s.name === "Note from the chat")?.detail).toBe(
    "Order two filters, not one.",
  );
  expect(t.tasks.requestOf(task.id)).toContain("make it two");
  expect(t.tasks.requestOf(task.id)).toContain("order a water filter");
  await t.thread.idle();
});

test("a desktop task reads a note from the chat with its next step", async () => {
  const { promise: gate, resolve } = Promise.withResolvers<void>();
  const work = new FakeModel([
    { content: [computer("screenshot")], wait: gate },
    finish("Booked for four."),
  ]);
  const t = await testApp(new FakeModel(), work);
  const task = startTask(t);
  await waitFor(() => work.requests.length === 1);
  expect(t.tasks.steer(task.id, { botId: task.botId, note: "Book for four people." })).toBeNull();
  resolve();
  await t.tasks.idle();
  expect(lastText(work.requests[1])).toContain("Book for four people.");
});

test("only a bot's own task that's still running can be steered", async () => {
  const work = new FakeModel([
    done("Done."),
    { content: [toolUse("wait", { minutes: 30, for: "a reply" })] },
  ]);
  const t = await testApp(new FakeModel(), work);
  const ended = t.tasks.createBackgroundTask({ title: "A", goal: "A", origin: "chat" }) as Task;
  await t.tasks.idle();
  expect(t.tasks.steer(ended.id, { botId: ended.botId, note: "More" })).toContain("has ended");
  const running = t.tasks.createBackgroundTask({ title: "B", goal: "B", origin: "chat" }) as Task;
  await waitFor(() => t.tasks.steps(running.id).find((s) => s.name === "wait"));
  const other = bot(t, "Scout");
  expect(t.tasks.steer(running.id, { botId: other.id, note: "Stop" })).toBe(
    `No task #${running.id} of yours.`,
  );
  expect(t.tasks.steps(running.id).some((s) => s.name === "Note from the chat")).toBe(false);
  t.tasks.cancel(running.id);
  await t.tasks.idle();
});

test("a note from a tainted chat taints the task it steers", async () => {
  const work = new FakeModel([
    { content: [toolUse("wait", { minutes: 30, for: "a reply" })] },
    done("Done."),
  ]);
  const t = await testApp(new FakeModel(), work);
  const task = t.tasks.createBackgroundTask({ title: "A", goal: "A", origin: "chat" }) as Task;
  await waitFor(() => t.tasks.steps(task.id).find((s) => s.name === "wait"));
  expect(task.tainted).toBe(false);
  t.tasks.steer(task.id, {
    botId: task.botId,
    note: "Go on",
    taintedBy: "The chat had read: A web page",
  });
  await t.tasks.idle();
  expect(t.tasks.get(task.id)?.taintedBy).toBe("The chat had read: A web page");
});
