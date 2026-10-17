import { expect, test } from "bun:test";
import { type Approval, latestNoteOnly, type Task, type TaskStep } from "@hatbot/shared";
import type { AgentElement } from "@hatbot/shared/desktop";
import { inBatches } from "../src/agent/tools";
import { DesktopError, HttpDesktopAgent } from "../src/desktop/client";
import { marketplaceSend } from "../src/negotiate/marketplace";
import { approvalKind } from "../src/tasks/approval-kind";
import { limits } from "../src/tasks/desktop-run";
import { browser, computer, FakeModel, text, toolUse } from "./fake-model";
import { setUpOwner, type TestApp, testApp, waitFor } from "./helpers";

const finish = (summary = "Booked it.") => ({
  content: [toolUse("finish_task", { outcome: "done", summary })],
});

function startTask(t: TestApp, goal = "Book a table") {
  return t.tasks.createDesktopTask({ title: goal, goal, successCriteria: "", origin: "chat" });
}

const pending = (t: TestApp) => waitFor(() => t.approvals.list(true)[0]);

/** What the last message of a request said. */
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

  expect(t.agent.actions.map((a) => a.name)).toEqual(["left_click"]);
  expect(task?.costUsd).toBeGreaterThan(0);

  // The request uses Haiku with the computer toolset, and results echo toolset_name.
  const req = work.requests[1];
  expect(req?.model).toBe("claude-haiku-5-5");
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

  // The chat model hears how it ended right away, and writes the reply that started it again: no
  // message of its own. The edited reply is unread until you've seen it.
  await t.thread.idle();
  // The task's news, then the app's note to the bot, as a system message.
  const told = JSON.stringify(chat.requests.at(-1)?.messages.slice(-2));
  expect(chat.requests.at(-1)?.messages.at(-1)?.role).toBe("system");
  expect(told).toContain("<task_updates>");
  expect(told).toContain("replaces your reply that started it");
  const after = t.thread.list().filter((m) => m.role === "assistant");
  expect(after.map((m) => m.id)).toEqual([reply?.id as number]);
  expect(after[0]?.text).toBe("It worked.");
  expect(after[0]?.status).toBe("done");
  expect(after[0]?.editedAt).toBeTruthy();
  expect(t.thread.unread()).toContain(reply?.id as number);
  t.chats.markSeen(t.thread.unread());
  expect(t.thread.unread()).toEqual([]);
  expect(t.notifier.sent.at(-1)?.title).toContain("Done");
  // Told once: your next message doesn't bring it up again.
  const asked = chat.requests.length;
  await t.thread.taskEnded();
  expect(chat.requests.length).toBe(asked);
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
  // A payment is approved in the app: the phone offers "Open in Hatbot", Deny, and Pause all,
  // which is always safe.
  expect(t.notifier.sent.at(-1)?.actions?.map((a) => a.label)).toEqual([
    "Open in Hatbot",
    "Deny",
    "Pause all",
  ]);
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
  expect(held).toContain("If that's the action you mean to take, call confirm_intent first.");
  expect(held).toContain("the label misled the check, reach the same place another way");
  expect(t.tasks.get(task.id)?.status).toBe("done");
});

test("outside a negotiation, a click or Enter that could message a seller asks first", async () => {
  const work = new FakeModel([
    { content: [computer("left_click", { coordinate: [300, 500] })] },
    { content: [computer("type", { text: "Czy aktualne? Dam 500." })] },
    { content: [computer("key", { text: "Return" })] },
    { content: [browser("left_click", { target: { type: "ref", ref: "ref_2" } })] },
    { content: [browser("left_click", { target: { type: "ref", ref: "ref_3" } })] },
    {
      content: [toolUse("confirm_intent", { kind: "send", summary: "Send the seller a question" })],
    },
    { content: [browser("left_click", { target: { type: "ref", ref: "ref_2" } })] },
    { content: [browser("left_click", { target: { type: "ref", ref: "ref_2" } })] },
    finish(),
  ]);
  const t = await testApp(new FakeModel(), work);
  const url = "https://www.olx.pl/d/oferta/rower-CID1-ID77.html";
  t.agent.page = { url, title: "Rower", text: "" };
  let fields: string[] = [];
  const box = (): AgentElement => ({
    tag: "textarea",
    role: null,
    type: null,
    label: "Wiadomość",
    inForm: true,
    url,
    editable: true,
    fields,
  });
  // The Send button has only an icon, so no label marks it as a send.
  const send = (): AgentElement => ({ ...box(), tag: "button", label: "", editable: false });
  const link = (): AgentElement => ({ ...box(), tag: "a", label: "Inne ogłoszenia" });
  Object.defineProperty(t.agent, "element", {
    get: () => {
      const ref = t.agent.inspected.at(-1)?.ref;
      return ref === "ref_2" ? send() : ref === "ref_3" ? link() : box();
    },
    configurable: true,
  });
  t.agent.afterAction = (name, input) => {
    if (name === "type") fields = [String(input.text)];
    if (name === "left_click" && t.agent.inspected.at(-1)?.ref === "ref_2") fields = [];
  };
  startTask(t, "Ask the seller if the bike is still for sale");
  const approval = await pending(t);
  expect(approval.summary).toBe("Send the seller a question");
  t.approvals.decide(approval.id, "approve", "web");
  await t.tasks.idle();

  const result = (i: number) => JSON.stringify(work.requests[i]?.messages.at(-1));
  // Clicking into the box and typing go; Enter and the icon-only Send wait for confirm_intent.
  expect(result(3)).toContain("Enter, with text in a box on olx.pl");
  expect(result(3)).toContain("call confirm_intent first");
  expect(result(4)).toContain("with text in a box on olx.pl");
  expect(t.agent.actions.map((a) => a.name)).toEqual(["left_click", "type"]);
  // A link isn't a send; the approved click goes once. With the box empty the marketplace check doesn't
  // ask, but a button with no label still does.
  expect(t.agent.browserCalls.map((c) => (c.input.target as { ref: string }).ref)).toEqual([
    "ref_3",
    "ref_2",
  ]);
  expect(result(8)).toContain("a button with no label");
  expect(result(8)).not.toContain("with text in a box");
  expect(marketplaceSend("click", send(), null)).toBeNull();
  expect(t.approvals.list(false)).toHaveLength(1);
  // Off the marketplaces, the ordinary check decides.
  expect(marketplaceSend("enter", { ...box(), url: "https://example.com/" }, null)).toBeNull();
  expect(marketplaceSend("enter", box(), null)).toBeNull();
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
  expect(t.tasks.requestOf(desk?.id as number)).toContain("now do it");
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

test("an approved desktop task waiting for the screen shows as queued", async () => {
  const work = new FakeModel([
    { content: [toolUse("confirm_intent", { kind: "send", summary: "Send the email" })] },
    finish("Sent."),
  ]);
  const t = await testApp(new FakeModel(), work);
  const task = startTask(t, "Send the email");
  const approval = await pending(t);
  expect(t.tasks.get(task.id)?.status).toBe("waiting_approval");
  // Another task has the screen meanwhile.
  await t.tasks.lane.acquire(-5, new AbortController().signal);
  t.approvals.decide(approval.id, "approve", "web");
  await waitFor(() => t.tasks.get(task.id)?.status === "queued");
  t.tasks.lane.release(-5);
  await t.tasks.idle();
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
  expect(buttons.map((b) => b.label)).toEqual(["Approve", "Deny", "Pause all"]);
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
  expect(await again.json()).toEqual({ error: "That was already answered." });
  expect((t.approvals.get(approval.id) as Approval).decidedVia).toBe("ntfy");
  await t.tasks.idle();
});

test("purchases, payments, mandates and budget raises can't be approved from a notification", async () => {
  const t = await testApp(new FakeModel(), new FakeModel());
  const kinds = [
    "purchase",
    "payment",
    "account_security",
    "mandate",
    "budget",
    "injection_warning",
  ] as const;
  for (const kind of kinds) {
    const a = t.approvals.create({ taskId: null, kind, summary: `A ${kind}` });
    const n = await waitFor(() => t.notifier.sent.find((x) => x.title === `Approve: A ${kind}`));
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
    expect(await approve.json()).toEqual({ error: "Open Hatbot to approve this." });
    expect(t.approvals.decide(a.id, "approve", "ntfy")).toBeNull();
    expect(t.approvals.get(a.id)?.status).toBe("pending");
    // Denying from the lock screen is fine.
    const button = n.actions?.[1];
    const deny = JSON.parse(button?.action === "http" ? (button.body ?? "") : "");
    const denied = await t.call("POST", `/approvals/${a.id}/token-decision`, deny);
    expect(denied.status).toBe(200);
    expect(t.approvals.get(a.id)).toMatchObject({ status: "denied", decidedVia: "ntfy" });
  }
});

test("a step that buys or pays asks as a purchase or a payment, whatever the model called it", async () => {
  expect(approvalKind("send", { summary: "Send the reply to Anna" }, { url: null, text: "" })).toBe(
    "send",
  );
  expect(approvalKind("other", { summary: "Click Kup teraz" }, { url: null, text: "" })).toBe(
    "purchase",
  );
  expect(approvalKind("send", { summary: "Zamów i zapłać" }, { url: null, text: "" })).toBe(
    "purchase",
  );
  expect(
    approvalKind(
      "other",
      { summary: "Click Next" },
      { url: "https://secure.payu.com/x", text: "" },
    ),
  ).toBe("payment");
  expect(
    approvalKind(
      "purchase",
      { summary: "Confirm" },
      { url: "https://shop.example/", text: "Podaj kod BLIK" },
    ),
  ).toBe("payment");
  expect(approvalKind("account_security", { summary: "Pay" }, { url: null, text: "" })).toBe(
    "account_security",
  );

  // In a task: a checkout click the model calls "send" gets no Approve button on the phone.
  const work = new FakeModel([
    { content: [toolUse("confirm_intent", { kind: "send", summary: "Click Buy now for $40" })] },
    finish(),
  ]);
  const t = await testApp(new FakeModel(), work);
  startTask(t, "Buy the cable");
  const approval = await pending(t);
  expect(approval.kind).toBe("purchase");
  expect(t.notifier.sent.at(-1)?.actions?.map((a) => a.label)).toEqual([
    "Open in Hatbot",
    "Deny",
    "Pause all",
  ]);
  t.approvals.decide(approval.id, "deny", "web");
  await t.tasks.idle();
});

test("Pause all on a notification pauses everything with its own signed token", async () => {
  const work = new FakeModel([
    { content: [toolUse("confirm_intent", { kind: "send", summary: "Post the reply" })] },
    finish(),
  ]);
  const t = await testApp(new FakeModel(), work);
  const task = startTask(t);
  const approval = await pending(t);
  const buttons = (t.notifier.sent.at(-1)?.actions ?? []) as { url: string; body: string }[];
  const pause = buttons[2] as { url: string; body: string };
  expect(pause.url).toBe("https://hatbot.test/api/v1/pause-all/token");
  const body = JSON.parse(pause.body) as { exp: number; sig: string };
  // An Approve button's signature doesn't pause, and a pause one doesn't approve.
  const approveSig = JSON.parse((buttons[0] as { body: string }).body).sig;
  expect((await t.call("POST", "/pause-all/token", { ...body, sig: approveSig })).status).toBe(403);
  expect(
    (
      await t.call("POST", `/approvals/${approval.id}/token-decision`, {
        decision: "approve",
        exp: body.exp,
        sig: body.sig,
      })
    ).status,
  ).toBe(403);
  expect((await t.call("POST", "/pause-all/token", { ...body, exp: body.exp + 1 })).status).toBe(
    403,
  );
  expect(t.settings.get().paused).toBe(false);
  const res = await t.call("POST", "/pause-all/token", body, { origin: "" });
  expect(res.status).toBe(200);
  expect(t.settings.get().paused).toBe(true);
  await t.tasks.idle();
  expect(t.tasks.get(task.id)?.status).not.toBe("running");
  // Once the approval it came with has expired, it's refused.
  t.advance(25 * 3600_000);
  expect((await t.call("POST", "/pause-all/token", body)).status).toBe(403);
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

test("a step's screenshot is served only as an image, to the app itself", async () => {
  const work = new FakeModel([{ content: [computer("screenshot")] }, finish()]);
  const t = await testApp(new FakeModel(), work);
  const { cookie } = await setUpOwner(t);
  const task = startTask(t);
  await t.tasks.idle();
  const step = t.tasks.steps(task.id).find((s) => s.screenshot);
  const res = await t.call("GET", `/tasks/${task.id}/screens/${step?.id}`, undefined, { cookie });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("image/webp");
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(res.headers.get("cross-origin-resource-policy")).toBe("same-origin");
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
  const { cookie } = await setUpOwner(t);
  const a = startTask(t, "A");
  await waitFor(() => t.tasks.get(a.id)?.status === "waiting_takeover");
  expect(t.tasks.lane.holderId).toBeNull();
  const b = startTask(t, "B");
  await waitFor(() => work.requests.length === 2);
  expect(t.tasks.lane.holderId).toBe(b.id);

  expect((await t.call("POST", "/desktop/takeover", undefined, { cookie })).status).toBe(200);
  expect(t.tasks.lane.holderId).toBe(a.id);
  expect(t.desktop.get()).toMatchObject({
    control: "owner",
    activeTaskId: a.id,
    request: { taskId: a.id },
  });
  done();
  await waitFor(() => t.tasks.get(b.id)?.status === "queued");
  expect((await t.call("POST", "/desktop/handback", undefined, { cookie })).status).toBe(200);
  await t.tasks.idle();
  expect(t.tasks.get(a.id)?.summary).toBe("A done.");
  expect(t.tasks.get(b.id)?.summary).toBe("B done.");
  // B's click was planned on a screen that changed: it never ran.
  expect(t.agent.actions.filter((x) => x.name === "left_click")).toEqual([]);
  expect(JSON.stringify(work.requests[3]?.messages.at(-1))).toContain(
    "another task had the desktop",
  );
  expect(t.desktop.get().request).toBeNull();
});

test("Take over says to try again while another task won't let go of the screen in time", async () => {
  limits.takeoverReadyMs = 100;
  let done = () => {};
  const slow = new Promise<void>((resolve) => {
    done = resolve;
  });
  const work = new FakeModel([
    { content: [toolUse("request_takeover", { reason: "Solve the captcha" })] },
    { content: [computer("left_click", { coordinate: [10, 10] })] },
    finish("B done."),
    finish("A done."),
  ]);
  const t = await testApp(new FakeModel(), work);
  const { cookie } = await setUpOwner(t);
  const action = t.agent.action.bind(t.agent);
  t.agent.action = async (x) => {
    if (x.name === "left_click") await slow;
    return action(x);
  };
  try {
    const a = startTask(t, "A");
    await waitFor(() => t.tasks.get(a.id)?.status === "waiting_takeover");
    const b = startTask(t, "B");
    // B is in the middle of its click.
    await waitFor(() => t.tasks.steps(b.id).some((s) => s.name === "left_click"));
    const busy = await t.call("POST", "/desktop/takeover", undefined, { cookie });
    expect(busy.status).toBe(409);
    expect(((await busy.json()) as { error: string }).error).toContain("Try again");
    expect(t.desktop.get().control).toBe("hatbot");
    done();
    await waitFor(() => t.tasks.get(b.id)?.status === "done");

    expect((await t.call("POST", "/desktop/takeover", undefined, { cookie })).status).toBe(200);
    expect((await t.call("POST", "/desktop/handback", undefined, { cookie })).status).toBe(200);
    await t.tasks.idle();
    expect(t.tasks.get(a.id)?.summary).toBe("A done.");
  } finally {
    limits.takeoverReadyMs = 8_000;
  }
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

test("a page is screened while the model reads it, its verdict before the actions, once per page", async () => {
  const work = new FakeModel([
    { content: [computer("screenshot")] },
    { content: [computer("screenshot")] },
    finish(),
  ]);
  const t = await testApp(new FakeModel(), work);
  const a = { url: "https://a.example/", title: "A", text: "Page A" };
  const b = { url: "https://b.example/", title: "B", text: "Page B" };
  t.agent.page = a;
  const pages = [a, b, a];
  const stream = work.stream.bind(work);
  work.stream = async (p, h) => {
    const res = await stream(p, h);
    t.agent.page = pages[work.requests.length] ?? a;
    return res;
  };
  // Haiku can't give a verdict on A: the first request is out, and its screenshot waits for you.
  work.onCreate = (p) => (JSON.stringify(p.messages).includes("Page A") ? "not JSON" : undefined);
  const task = startTask(t);
  const approval = await pending(t);
  expect(approval.reason).toContain("couldn't check this page");
  expect(work.requests).toHaveLength(1);
  expect(t.agent.actions).toHaveLength(0);
  expect(work.creates[0]?.output_config?.format?.type).toBe("json_schema");
  t.approvals.decide(approval.id, "approve", "web");
  work.onCreate = () => '{"suspected": false, "excerpt": ""}';
  await t.tasks.idle();
  expect(t.tasks.get(task.id)?.status).toBe("done");
  expect(t.tasks.get(task.id)?.injectionSuspected).toBe(false);
  // A, then B; A again was trusted once you said to go on.
  expect(work.creates).toHaveLength(2);
});

test("a desktop task starts with the old tabs closed, on a desktop-agent old or new", async () => {
  const t = await testApp(new FakeModel(), new FakeModel([finish()]));
  startTask(t);
  await t.tasks.idle();
  expect(t.agent.resets).toBe(1);

  let status = 200;
  const paths: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: (req) => {
      paths.push(`${req.method} ${new URL(req.url).pathname}`);
      return new Response("{}", { status });
    },
  });
  try {
    const client = new HttpDesktopAgent(`http://127.0.0.1:${server.port}`, "token");
    expect(await client.resetBrowser()).toBe(true);
    status = 404;
    expect(await client.resetBrowser()).toBe(false);
    status = 500;
    await expect(client.resetBrowser()).rejects.toThrow();
    expect(paths[0]).toBe("POST /browser/reset");
  } finally {
    server.stop(true);
  }
});

test("a page seen again isn't screened again", async () => {
  const work = new FakeModel([
    { content: [computer("screenshot")] },
    { content: [computer("screenshot")] },
    finish(),
  ]);
  const t = await testApp(new FakeModel(), work);
  const a = { url: "https://a.example/", title: "A", text: "Page A" };
  const b = { url: "https://a.example/b", title: "B", text: "Page B" };
  t.agent.page = a;
  const pages = [a, b, a];
  const stream = work.stream.bind(work);
  work.stream = async (p, h) => {
    const res = await stream(p, h);
    t.agent.page = pages[work.requests.length] ?? a;
    return res;
  };
  startTask(t);
  await t.tasks.idle();
  expect(work.creates.map((c) => JSON.stringify(c.messages).includes("Page A"))).toEqual([
    true,
    false,
  ]);
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
  t.settings.update({
    limits: { taskUsd: 0.02, dailyUsd: 10, monthlyUsd: 200 },
    desktopModel: "claude-opus-5-5",
  });
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

test("an approval holds only on its page, and a task waiting for one keeps its tabs", async () => {
  const work = new FakeModel([
    // A asks to pay on its order page...
    { content: [toolUse("confirm_intent", { kind: "payment", summary: "Click Zapłać" })] },
    // ...B runs meanwhile and leaves the browser on another site...
    finish("B done."),
    // ...so A's click there isn't the one approved.
    { content: [computer("left_click", { coordinate: [300, 520] })] },
    finish("A stopped."),
  ]);
  const t = await testApp(new FakeModel(), work);
  const order = "https://shop.example/order/1";
  t.agent.page = { url: order, title: "Order", text: "" };
  const a = startTask(t, "A");
  const b = startTask(t, "B");
  const approval = await pending(t);
  await waitFor(() => t.tasks.get(b.id)?.status === "done");
  // B didn't close A's tabs: it opened its own.
  expect(t.agent.resets).toBe(1);
  expect(t.agent.browserCalls.map((c) => c.name)).toEqual(["new_tab"]);

  const elsewhere = "https://other.example/";
  t.agent.page = { url: elsewhere, title: "Other", text: "" };
  t.agent.element = {
    tag: "button",
    role: null,
    type: "button",
    label: "Zapłać",
    inForm: false,
    url: elsewhere,
  };
  t.approvals.decide(approval.id, "approve", "web");
  await t.tasks.idle();
  expect(t.tasks.get(a.id)?.summary).toBe("A stopped.");
  const said = (n: number) => JSON.stringify(work.requests[n]?.messages.at(-1)?.content);
  expect(said(2)).toContain(`the page you asked about (${order}) isn't on screen now`);
  expect(said(3)).toContain(`The owner's approval was for a step on ${order}, not this page.`);
  expect(t.agent.actions.filter((x) => x.name === "left_click")).toEqual([]);
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
  expect(t.settings.get().desktopModel).toBe("claude-haiku-5-5");
  t.settings.update({ desktopModel: "claude-opus-5-5" });
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

  const said = (n: number) => JSON.stringify(work.requests[n]?.messages.at(-1)?.content);
  expect(said(1)).toContain('lands in an embedded frame (\\"PayU\\")');
  expect(said(2)).toContain("couldn't see what this click would act on");
  expect(said(3)).toContain("couldn't see what this click would act on");
  expect(t.agent.browserCalls).toEqual([]);
  expect(t.agent.actions.map((a) => a.input)).toEqual([{ coordinate: [400, 10] }]);
});

test("Space, mouse up, a drag, Enter after Tab and Enter in a chat box don't slip past", async () => {
  const pay = { tag: "button", role: null, type: "button", label: "Zapłać", inForm: false };
  const chat = {
    tag: "textarea",
    role: null,
    type: null,
    label: "Napisz wiadomość",
    inForm: false,
    editable: true,
    buttonsAfter: ["", "Wyślij"],
  };
  const work = new FakeModel([
    { content: [computer("key", { text: "space" })] },
    { content: [computer("left_mouse_down")] },
    { content: [computer("left_mouse_up")] },
    {
      content: [computer("left_click_drag", { start_coordinate: [5, 5], coordinate: [300, 520] })],
    },
    { content: [computer("key", { text: "Tab Return" })] },
    { content: [computer("hold_key", { text: "Return", duration: 1 })] },
    { content: [browser("key", { text: "Return" })] },
    { content: [browser("type", { text: "Dzień dobry\n" })] },
    finish(),
  ]);
  const t = await testApp(new FakeModel(), work);
  t.agent.element = pay;
  const stream = work.stream.bind(work);
  work.stream = async (p, h) => {
    const res = await stream(p, h);
    // The last two land in a chat box whose Send is after it.
    if (work.requests.length >= 7) t.agent.element = chat;
    return res;
  };
  startTask(t, "Write to the seller");
  await t.tasks.idle();

  // Nothing ran: each was held or refused.
  expect(t.agent.actions.filter((a) => a.name !== "cursor_position")).toEqual([]);
  expect(t.agent.browserCalls).toEqual([]);
  const said = (n: number) => JSON.stringify(work.requests[n]?.messages.at(-1)?.content);
  expect(said(1)).toContain('press \\"Zapłać\\"');
  expect(said(2)).toContain('click \\"Zapłać\\"');
  expect(said(3)).toContain('click \\"Zapłać\\"');
  expect(said(4)).toContain('click \\"Zapłać\\"');
  expect(said(5)).toContain("in a key action of its own");
  expect(said(6)).toContain("Holding Enter or Space repeats it");
  expect(said(7)).toContain('submit with \\"Wyślij\\"');
  expect(said(8)).toContain('submit with \\"Wyślij\\"');
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

test("changes on different things run at once; on the same thing, in order", async () => {
  const log: string[] = [];
  const run = async (c: string) => {
    log.push(`start ${c}`);
    await Bun.sleep(5);
    log.push(`end ${c}`);
    return c;
  };
  // "a1" on host a, "b1" on host b, "a2" on a again, "r" a lookup.
  const on = (c: string) => (c === "r" ? true : (c[0] as string));
  await inBatches(["a1", "b1", "a2", "r"], on, run);
  expect(log).toEqual([
    "start a1",
    "start b1",
    "end a1",
    "end b1",
    "start a2",
    "end a2",
    "start r",
    "end r",
  ]);
});

test("a task's timeline keeps only the model's latest note, and all of yours", () => {
  const step = (id: number, kind: TaskStep["kind"], name = "Note") =>
    ({ id, kind, name }) as TaskStep;
  const steps = [
    step(1, "note"),
    step(2, "action"),
    step(3, "note", "Your note"),
    step(4, "note", "Trying again on Opus"),
    step(5, "note"),
  ];
  expect(latestNoteOnly(steps).map((s) => s.id)).toEqual([2, 3, 4, 5]);
});

test("a task waits without a slot, wakes on an event, and can notify before it ends", async () => {
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
  });
  if (!task) throw new Error("no task");
  await waitFor(() => t.tasks.steps(task.id).find((s) => s.name === "wait"));
  // Waiting gives its slot back: every slot is free.
  const signal = AbortSignal.timeout(500);
  for (let i = 0; i < t.tasks.pool.size; i++) await t.tasks.pool.acquire(signal);
  for (let i = 0; i < t.tasks.pool.size; i++) t.tasks.pool.release();
  t.tasks.tell(task.id, "Backup job finished OK.");
  await t.tasks.idle();
  expect(t.tasks.get(task.id)?.summary).toBe("Backup finished.");
  const results = JSON.stringify(work.requests[1]?.messages.at(-1));
  expect(results).toContain("Woke early");
  expect(results).toContain("Backup job finished OK.");
  expect(t.notifier.sent.map((n) => n.message)).toEqual(["The backup started late."]);
});

test("a summary whose chart doesn't draw goes back to the task once", async () => {
  const broken = '```chart\n{"type":"line","x":["1"],"series":[{"data":[1,2]}]}\n```';
  const fixed = '```chart\n{"type":"line","x":["1","2"],"series":[{"data":[1,2]}]}\n```';
  const done = (summary: string) => ({
    content: [toolUse("finish_task", { outcome: "done", summary, notify: false })],
  });
  const work = new FakeModel([done(broken), done(fixed)]);
  const t = await testApp(new FakeModel(), work);
  const task = t.tasks.createBackgroundTask({
    title: "Chart",
    goal: "Chart it",
    origin: "schedule",
    source: "nightly",
    runKey: "schedule:2",
  });
  if (!task) throw new Error("no task");
  await t.tasks.idle();
  expect(t.tasks.get(task.id)?.summary).toBe(fixed);
  expect(JSON.stringify(work.requests[1]?.messages.at(-1))).toContain(
    "chart 1 doesn't draw (x has 1 value but series 1 has 2 values)",
  );

  // Still broken the second time: it's kept as it is rather than holding the task up.
  const again = new FakeModel([done(broken), done(broken)]);
  const t2 = await testApp(new FakeModel(), again);
  const task2 = t2.tasks.createBackgroundTask({
    title: "Chart",
    goal: "Chart it",
    origin: "schedule",
    source: "nightly",
    runKey: "schedule:3",
  });
  if (!task2) throw new Error("no task");
  await t2.tasks.idle();
  expect(t2.tasks.get(task2.id)?.summary).toBe(broken);
});

test("an ended task runs again with its goal as you edited it, still tainted", async () => {
  const work = new FakeModel([
    { content: [toolUse("finish_task", { outcome: "done", summary: "First.", notify: false })] },
    { content: [toolUse("finish_task", { outcome: "done", summary: "Second.", notify: false })] },
  ]);
  const t = await testApp(new FakeModel(), work);
  const { cookie } = await setUpOwner(t);
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
    title: "Deploy",
    goal: "Deploy main again",
    origin: "webhook",
    source: "Forgejo",
    payload: '{"ref":"main"}',
    tainted: true,
    taintedBy: "The event that started it (Forgejo)",
  });
  // Still running: not twice at once.
  expect((await t.call("POST", `/tasks/${again.id}/rerun`, {}, { cookie })).status).toBe(409);
  await waitFor(() => t.tasks.get(again.id)?.finishedAt);
  expect(JSON.stringify(work.requests[1]?.messages)).toContain("Deploy main again");
});

const SCREENING = '{"suspected": false, "excerpt": ""}';

test("a Haiku desktop task out of steps carries on, once, on Opus, with Haiku's account", async () => {
  const shot = { content: [computer("screenshot")] };
  const work = new FakeModel([shot, shot, shot, finish("Booked on Opus.")]);
  work.onCreate = (p) =>
    JSON.stringify(p.messages).includes("You were stopped")
      ? "I opened the booking page, but the date picker didn't take a click."
      : SCREENING;
  const t = await testApp(new FakeModel(), work);
  limits.maxSteps = 3;
  try {
    const task = startTask(t);
    await t.tasks.idle();
    const ended = t.tasks.get(task.id);
    expect(ended?.status).toBe("done");
    expect(ended?.summary).toBe("Booked on Opus.");
    expect(ended?.model).toBe("claude-opus-5-5");
    expect(work.requests.map((r) => r.model)).toEqual([
      "claude-haiku-5-5",
      "claude-haiku-5-5",
      "claude-haiku-5-5",
      "claude-opus-5-5",
    ]);
    // Haiku was asked what it tried on its own conversation, and Opus starts afresh with it.
    const asked = work.creates.find((c) => JSON.stringify(c.messages).includes("You were stopped"));
    expect(asked?.model).toBe("claude-haiku-5-5");
    const opus = JSON.stringify(work.requests[3]?.messages);
    expect(work.requests[3]?.messages.length).toBe(1);
    expect(opus).toContain('<earlier_attempt trusted=\\"false\\">');
    expect(opus).toContain("Stopped after 3 steps without finishing.");
    expect(opus).toContain("the date picker didn't take a click");
    expect(t.tasks.steps(task.id).some((s) => s.name === "Trying again on Opus")).toBe(true);
    // One task: no second card, and one notification.
    expect(t.notifier.sent.filter((n) => n.title.includes("Book a table")).length).toBe(1);
  } finally {
    limits.maxSteps = 80;
  }
});

test("a Haiku desktop task that gives up carries on on Opus with what it said", async () => {
  const work = new FakeModel([
    {
      content: [
        toolUse("finish_task", { outcome: "failed", summary: "The search never loaded results." }),
      ],
    },
    finish("Found it on Opus."),
  ]);
  const t = await testApp(new FakeModel(), work);
  const task = startTask(t);
  await t.tasks.idle();
  expect(t.tasks.get(task.id)).toMatchObject({ status: "done", model: "claude-opus-5-5" });
  expect(JSON.stringify(work.requests[1]?.messages)).toContain("The search never loaded results.");
  // Its own summary is its account: Haiku isn't asked again.
  expect(work.creates.some((c) => JSON.stringify(c.messages).includes("You were stopped"))).toBe(
    false,
  );
});

test("a desktop reply with no tool call is asked to finish once; again, and Opus carries on", async () => {
  const work = new FakeModel([
    { content: [text("I think that's it.")] },
    { content: [text("The table is booked, I believe.")] },
    finish("Checked: booked on Opus."),
  ]);
  const t = await testApp(new FakeModel(), work);
  const task = startTask(t);
  await t.tasks.idle();
  expect(t.tasks.get(task.id)).toMatchObject({
    status: "done",
    summary: "Checked: booked on Opus.",
    model: "claude-opus-5-5",
  });
  expect(lastText(work.requests[1])).toContain("only finish_task ends the task");
  const opus = JSON.stringify(work.requests[2]?.messages);
  expect(opus).toContain("The table is booked, I believe.");

  // Asked once, it finishes.
  const once = new FakeModel([{ content: [text("Done, I think.")] }, finish("Booked.")]);
  const t2 = await testApp(new FakeModel(), once);
  const b = startTask(t2);
  await t2.tasks.idle();
  expect(t2.tasks.get(b.id)).toMatchObject({ status: "done", summary: "Booked." });
  expect(once.requests.map((r) => r.model)).toEqual(["claude-haiku-5-5", "claude-haiku-5-5"]);
});

test("a background reply with no tool call is asked to finish once; again, it has failed", async () => {
  const work = new FakeModel([
    { content: [text("All backups look fine.")] },
    { content: [text("Yes, all fine.")] },
  ]);
  const t = await testApp(new FakeModel(), work);
  const task = t.tasks.createBackgroundTask({ title: "Backups", goal: "Check", origin: "chat" });
  await t.tasks.idle();
  expect(t.tasks.get(task?.id ?? 0)).toMatchObject({ status: "failed", summary: "Yes, all fine." });
  expect(lastText(work.requests[1])).toContain("only finish_task ends the task");
});

test("blocked, budget, cancelled and switched-off desktop tasks don't carry on on Opus", async () => {
  // Blocked on a login: Opus can't get past it either.
  const blocked = new FakeModel([
    { content: [toolUse("finish_task", { outcome: "blocked", summary: "It needs a login." })] },
  ]);
  const t1 = await testApp(new FakeModel(), blocked);
  const a = startTask(t1);
  await t1.tasks.idle();
  expect(t1.tasks.get(a.id)).toMatchObject({ status: "failed", model: "claude-haiku-5-5" });
  expect(blocked.requests.length).toBe(1);

  // Today's limit is spent.
  const broke = new FakeModel([]);
  const t2 = await testApp(new FakeModel(), broke);
  t2.settings.update({ limits: { taskUsd: 3, dailyUsd: 0.0001, monthlyUsd: 200 } });
  const b = startTask(t2);
  await t2.tasks.idle();
  expect(t2.tasks.get(b.id)?.summary).toStartWith("Stopped: Today's");
  expect(broke.requests.length).toBe(0);

  // Cancelled while it runs.
  let release = () => {};
  const held = new FakeModel([
    { content: [computer("screenshot")], wait: new Promise<void>((r) => (release = r)) },
  ]);
  const t3 = await testApp(new FakeModel(), held);
  const c = startTask(t3);
  await waitFor(() => held.requests.length);
  t3.tasks.cancel(c.id);
  release();
  await t3.tasks.idle();
  expect(t3.tasks.get(c.id)).toMatchObject({ status: "cancelled", model: "claude-haiku-5-5" });

  // Switched off in Settings.
  const off = new FakeModel([
    { content: [toolUse("finish_task", { outcome: "failed", summary: "No luck." })] },
  ]);
  const t4 = await testApp(new FakeModel(), off);
  t4.settings.update({ desktopEscalate: false });
  const d = startTask(t4);
  await t4.tasks.idle();
  expect(t4.tasks.get(d.id)).toMatchObject({ status: "failed", summary: "No luck." });
  expect(off.requests.length).toBe(1);
});

test("the weekly report counts desktop tasks by the model they started on", async () => {
  const t = await testApp();
  const add = (
    model: string,
    status: string,
    from: string | null = null,
    parent: number | null = null,
  ) =>
    t.db
      .query(
        `INSERT INTO tasks (title, goal, success_criteria, origin, lane, model, status, budget_usd, created_at, escalated_from, parent_id)
         VALUES ('d', 'g', '', 'chat', 'screen', ?, ?, 1, '2026-10-08T00:00:00Z', ?, ?)`,
      )
      .run(model, status, from, parent);
  add("claude-haiku-5-5", "done");
  add("claude-haiku-5-5", "done");
  add("claude-haiku-5-5", "failed");
  add("claude-opus-5-5", "done", "claude-haiku-5-5");
  add("claude-opus-5-5", "failed", "claude-haiku-5-5");
  add("claude-opus-5-5", "done", null, 1);
  add("claude-haiku-5-5", "cancelled");
  const { text } = await t.report.make();
  expect(text).toContain("- Desktop on Haiku 5.5: 2 done, 3 failed, 1 of them then done on Opus.");
  expect(text).toContain("- Desktop on Opus 5.5: 1 done, 0 failed.");
});

test("cancelling a desktop task stops the rest of the actions in its turn", async () => {
  const work = new FakeModel([
    {
      content: [
        computer("left_click", { coordinate: [10, 10] }),
        computer("type", { text: "hello" }),
        computer("key", { text: "Return" }),
      ],
    },
  ]);
  const t = await testApp(new FakeModel(), work);
  const task = startTask(t);
  t.agent.afterAction = (name) => {
    if (name === "left_click") t.tasks.cancel(task.id);
  };
  await t.tasks.idle();
  expect(t.agent.actions.map((a) => a.name)).toEqual(["left_click"]);
  expect(t.tasks.get(task.id)?.status).toBe("cancelled");
  const turns = t.db
    .query<{ content: string }, [number]>(
      "SELECT content FROM task_turns WHERE task_id = ? AND role = 'user' ORDER BY id DESC LIMIT 1",
    )
    .get(task.id)?.content;
  expect(turns).toContain("Not run: the task was cancelled.");
});

test("cancelling a background task stops the rest of the calls in its turn", async () => {
  const work = new FakeModel([
    {
      content: [
        toolUse("notify_owner", { message: "Starting." }),
        toolUse("memory_write", { path: "notes/late.md", content: "late" }),
      ],
    },
  ]);
  const t = await testApp(new FakeModel(), work);
  t.tasks.notifyOwner = (id: number) => void t.tasks.cancel(id);
  const task = t.tasks.createBackgroundTask({ title: "Two", goal: "Do two", origin: "chat" });
  await t.tasks.idle();
  expect(t.tasks.get(task?.id ?? 0)?.status).toBe("cancelled");
  expect(await t.memory.exists("notes/late.md")).toBe(false);
});

test("a desktop client request ends as soon as its task's signal aborts", async () => {
  const server = Bun.serve({
    port: 0,
    fetch: () => new Promise<Response>((r) => setTimeout(() => r(Response.json({})), 5000)),
  });
  try {
    const stop = new AbortController();
    const agent = new HttpDesktopAgent(`http://localhost:${server.port}`, "token").withSignal(
      stop.signal,
    );
    const started = Date.now();
    const pending = agent.action({ name: "wait", input: { duration: 5 } });
    setTimeout(() => stop.abort(new Error("cancelled")), 20);
    await expect(pending).rejects.toThrow("cancelled");
    expect(Date.now() - started).toBeLessThan(2000);
  } finally {
    server.stop(true);
  }
});

test("an answered background task waiting for a slot shows as queued, not waiting for approval", async () => {
  const work = new FakeModel([
    { content: [toolUse("finish_task", { outcome: "done", summary: "Fine.", notify: false })] },
  ]);
  const t = await testApp(new FakeModel(), work);
  t.settings.update({ limits: { taskUsd: 0.05, dailyUsd: 10, monthlyUsd: 200 } });
  const task = t.tasks.createBackgroundTask({ title: "Check", goal: "Check", origin: "chat" });
  const approval = await pending(t);
  expect(t.tasks.get(task?.id ?? 0)?.status).toBe("waiting_approval");
  // Every slot is taken meanwhile.
  const signal = AbortSignal.timeout(2000);
  for (let i = 0; i < t.tasks.pool.size; i++) await t.tasks.pool.acquire(signal);
  t.approvals.decide(approval.id, "approve", "web");
  await waitFor(() => t.tasks.get(task?.id ?? 0)?.status === "queued");
  for (let i = 0; i < t.tasks.pool.size; i++) t.tasks.pool.release();
  // Each approval adds one task limit; keep approving until it finishes.
  for (;;) {
    const next = await waitFor(
      () => t.approvals.list(true)[0] ?? (t.tasks.get(task?.id ?? 0)?.status === "done" && "done"),
    );
    if (next === "done") break;
    t.approvals.decide((next as Approval).id, "approve", "web");
  }
  await t.tasks.idle();
  expect(t.tasks.get(task?.id ?? 0)?.status).toBe("done");
});

test("a background run stops after 4 hours of its own time, and waits no longer than that", async () => {
  let release = () => {};
  let release2 = () => {};
  const work = new FakeModel([
    {
      content: [toolUse("wait", { minutes: 240, for: "the build" })],
      wait: new Promise<void>((r) => {
        release = r;
      }),
    },
    {
      content: [toolUse("memory_list", {})],
      wait: new Promise<void>((r) => {
        release2 = r;
      }),
    },
  ]);
  const t = await testApp(new FakeModel(), work);
  const task = t.tasks.createBackgroundTask({ title: "Long", goal: "Watch", origin: "schedule" });
  const id = task?.id ?? 0;
  await waitFor(() => work.requests.length);
  t.advance(3.9 * 3600_000);
  release();
  const step = await waitFor(() => t.tasks.steps(id).find((s) => s.name === "wait"));
  expect(step.detail).toBe("Waiting up to 6 min for the build");
  t.tasks.tell(id, "The build finished.");
  await waitFor(() => work.requests.length === 2);
  t.advance(10 * 60_000);
  release2();
  await t.tasks.idle();
  expect(t.tasks.get(id)).toMatchObject({ status: "failed" });
  expect(t.tasks.get(id)?.summary).toContain("4 hours");
});

test("a run that throws while it sets up ends as failed, and its schedule can run again", async () => {
  const work = new FakeModel([
    { content: [toolUse("finish_task", { outcome: "done", summary: "Ran.", notify: false })] },
  ]);
  const t = await testApp(new FakeModel(), work);
  const tools = t.plugins.tools;
  t.plugins.tools = () => {
    throw new Error("a plugin broke");
  };
  const run = {
    title: "Nightly",
    goal: "Check",
    origin: "schedule",
    runKey: "schedule:9",
  } as const;
  const first = t.tasks.createBackgroundTask(run);
  await t.tasks.idle();
  expect(t.tasks.get(first?.id ?? 0)).toMatchObject({ status: "failed" });
  expect(t.tasks.get(first?.id ?? 0)?.summary).toContain("a plugin broke");
  t.plugins.tools = tools;
  const second = t.tasks.createBackgroundTask(run);
  expect(second).not.toBeNull();
  await t.tasks.idle();
  expect(t.tasks.get(second?.id ?? 0)).toMatchObject({ status: "done", summary: "Ran." });
});

test("a Haiku desktop task out of context carries on on Opus without being asked what it tried", async () => {
  const work = new FakeModel([
    { content: [computer("screenshot")], stop_reason: "model_context_window_exceeded" },
    finish("Booked on Opus."),
  ]);
  const t = await testApp(new FakeModel(), work);
  const task = startTask(t);
  await t.tasks.idle();
  expect(t.tasks.get(task.id)).toMatchObject({ status: "done", model: "claude-opus-5-5" });
  // One look at the start of each attempt: the cut-off screenshot call didn't run.
  expect(t.agent.screenshots).toBe(2);
  expect(work.creates.some((c) => JSON.stringify(c.messages).includes("You were stopped"))).toBe(
    false,
  );
  expect(JSON.stringify(work.requests[1]?.messages)).toContain("got too long");
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
  expect(t.tasks.get(task?.id ?? 0)).toMatchObject({ status: "failed" });
  expect(t.tasks.get(task?.id ?? 0)?.summary).toContain("too long");
  expect(await t.memory.exists("notes/z.md")).toBe(false);
});
