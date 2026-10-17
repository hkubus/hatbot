import { expect, test } from "bun:test";
import Anthropic from "@anthropic-ai/sdk";
import { retryable, withRetries } from "../src/agent/model";
import type { BudgetError } from "../src/spend";
import { Tasks } from "../src/tasks/service";
import { FakeModel, text, toolUse } from "./fake-model";
import { setUpOwner, testApp, waitFor } from "./helpers";

const lastUserText = (req: { messages: { role: string; content: unknown }[] }) =>
  JSON.stringify(req.messages.at(-1)?.content);

const summarized = (t: Awaited<ReturnType<typeof testApp>>) =>
  t.db.query<{ id: number; summarized: number }, []>("SELECT id, summarized FROM episodes").all();

test("a reply still running isn't summarized, however long it takes", async () => {
  let release = () => {};
  const slow = new Promise<void>((r) => {
    release = r;
  });
  const model = new FakeModel(
    [{ content: [text("Done at last.")], wait: slow }],
    ["<recap>R</recap><summary>S</summary>"],
  );
  const t = await testApp(model);
  const { done } = t.thread.post("a slow one");
  await waitFor(() => model.requests.length);
  t.advance(31 * 60_000);
  await t.thread.sweep();
  expect(model.creates.length).toBe(0);
  release();
  await done;
  // It just ended: active again, so not idle yet.
  await t.thread.sweep();
  expect(model.creates.length).toBe(0);
  t.advance(31 * 60_000);
  await t.thread.sweep();
  expect(model.creates.length).toBe(1);
  expect(summarized(t)).toEqual([{ id: 1, summarized: 1 }]);
});

test("a summary that fails is tried again, and given up after three tries", async () => {
  const model = new FakeModel(
    [{ content: [text("one")] }, { content: [text("two")] }],
    ["", "<summary>S</summary>", "", "", ""],
  );
  const t = await testApp(model);
  await t.thread.post("first").done;
  t.advance(31 * 60_000);
  await t.thread.sweep();
  expect(summarized(t)).toEqual([{ id: 1, summarized: 0 }]);
  await t.thread.sweep();
  expect(summarized(t)).toEqual([{ id: 1, summarized: 1 }]);

  await t.thread.post("second").done;
  t.advance(31 * 60_000);
  for (let i = 0; i < 3; i++) await t.thread.sweep();
  expect(summarized(t).at(-1)).toEqual({ id: 2, summarized: 1 });
  await t.thread.sweep();
  expect(model.creates.length).toBe(5);
  expect(lastUserText(model.requests[1] as never)).toContain("earlier_conversations>\\nS\\n");
});

test("a conversation whose last request passed 90k tokens carries on in a new one", async () => {
  const model = new FakeModel(
    [
      {
        content: [text("A long answer.")],
        usage: { input_tokens: 2000, cache_read_input_tokens: 93_000 },
      },
      { content: [text("Fresh start.")] },
    ],
    ["<summary>They talked at length.</summary>"],
  );
  const t = await testApp(model);
  await t.thread.post("first").done;
  t.advance(60_000);
  await t.thread.post("second").done;
  expect(model.requests[1]?.messages.length).toBe(1);
  const opening = lastUserText(model.requests[1] as never);
  expect(opening).toContain(
    '<message from=\\"Owner\\" at=\\"Fri 2026-10-09 12:00\\">first</message>',
  );
  expect(opening).toContain("They talked at length.");
  const [one, two] = t.thread.list().filter((m) => m.role === "user");
  expect(two?.episodeId).not.toBe(one?.episodeId as number);
  expect(t.events.some((e) => e.type === "message.progress" && e.text.includes("got long"))).toBe(
    true,
  );
  // The chat reads less of a page than a task does.
  const fetch = model.requests[0]?.tools?.find((x) => "name" in x && x.name === "web_fetch");
  expect(fetch).toMatchObject({ max_content_tokens: 10000 });
});

test("a background task clears old tool results past 70k", async () => {
  const work = new FakeModel([
    { content: [toolUse("finish_task", { outcome: "done", summary: "Done.", notify: false })] },
  ]);
  const t = await testApp(new FakeModel(), work);
  t.tasks.createBackgroundTask({ title: "Check", goal: "Check", origin: "schedule" });
  await t.tasks.idle();
  const req = work.requests[0];
  expect(req?.betas).toContain("context-management-2025-06-27");
  expect(req?.context_management?.edits?.[0]).toMatchObject({
    type: "clear_tool_uses_20250919",
    trigger: { type: "input_tokens", value: 70_000 },
  });
});

const breakpoints = (req: unknown) => JSON.stringify(req).match(/"cache_control"/g)?.length ?? 0;

test("tasks cache their tools and system apart from the conversation, within four breakpoints", async () => {
  const done = { outcome: "done", summary: "Done.", notify: false };
  const work = new FakeModel([
    { content: [toolUse("finish_task", done)] },
    { content: [toolUse("finish_task", { outcome: "done", summary: "Booked." })] },
  ]);
  const t = await testApp(new FakeModel([{ content: [text("Hi.")] }]), work);
  t.tasks.createBackgroundTask({ title: "Check", goal: "Check", origin: "schedule" });
  await t.tasks.idle();
  t.tasks.createDesktopTask({ title: "Book", goal: "Book", successCriteria: "", origin: "chat" });
  await t.tasks.idle();
  await t.thread.post("hello").done;
  for (const req of [...work.requests, ...t.model.requests]) {
    expect((req.system as { cache_control?: unknown }[])[0]?.cache_control).toBeDefined();
    expect(req.cache_control).toBeDefined();
    expect(breakpoints(req)).toBeLessThanOrEqual(4);
  }
  expect(work.requests).toHaveLength(2);
});

test("a stream that fails partway is tried again; one the owner stopped isn't", async () => {
  const overloaded = new Anthropic.APIError(
    undefined,
    { type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
    undefined,
    undefined,
    "overloaded_error",
  );
  expect(retryable(overloaded)).toBe(true);
  expect(retryable(new Anthropic.APIConnectionError({ message: "reset" }))).toBe(true);
  expect(retryable(new Anthropic.APIUserAbortError())).toBe(false);
  expect(retryable(new Anthropic.APIError(400, undefined, "bad", undefined))).toBe(false);

  let tries = 0;
  let retries = 0;
  const flaky = () => {
    tries++;
    if (tries < 3) throw overloaded;
    return Promise.resolve("ok");
  };
  expect(await withRetries(flaky, { onRetry: () => retries++ }, [0, 0])).toBe("ok");
  expect([tries, retries]).toEqual([3, 2]);

  tries = 0;
  const always = () => {
    tries++;
    return Promise.reject(overloaded);
  };
  await expect(withRetries(always, {}, [0, 0])).rejects.toBe(overloaded);
  expect(tries).toBe(3);

  tries = 0;
  const stopped = new AbortController();
  stopped.abort();
  await expect(withRetries(always, { signal: stopped.signal }, [0, 0])).rejects.toBe(overloaded);
  expect(tries).toBe(1);
});

test("a reply whose stream is tried again drops what it had streamed", async () => {
  const model = new FakeModel([{ content: [text("The whole answer.")], failedWith: "The who" }]);
  const t = await testApp(model);
  await t.thread.post("hi").done;
  const reply = t.thread.list().find((m) => m.role === "assistant");
  expect(reply?.text).toBe("The whole answer.");
  const at = t.events.findIndex((e) => e.type === "message.rewrite" && e.id === reply?.id);
  expect(at).toBeGreaterThan(-1);
  const after = t.events
    .slice(at)
    .flatMap((e) => (e.type === "message.delta" && e.id === reply?.id ? [e.text] : []));
  expect(after.join("")).toBe("The whole answer.");
});

test("a reply that failed is written again in place, from the turns it had", async () => {
  const model = new FakeModel([]);
  const t = await testApp(model);
  const { cookie } = await setUpOwner(t);
  await t.thread.post("what's 2+2?").done;
  const failed = t.thread.list().find((m) => m.role === "assistant");
  expect(failed?.status).toBe("error");

  model.script.push({ content: [text("4.")] });
  const res = await t.call("POST", `/thread/messages/${failed?.id}/retry`, undefined, { cookie });
  expect(res.status).toBe(202);
  await t.thread.idle();
  const after = t.thread.list();
  expect(after.filter((m) => m.role === "user")).toHaveLength(1);
  expect(after.filter((m) => m.role === "assistant")).toEqual([
    expect.objectContaining({ id: failed?.id, text: "4.", status: "done", editedAt: null }),
  ]);
  // The same request again: the owner's message once, nothing added.
  expect(model.requests).toHaveLength(2);
  expect(model.requests[1]?.messages).toEqual(model.requests[0]?.messages as never);
  expect(t.events.some((e) => e.type === "message.rewrite" && e.id === failed?.id)).toBe(true);

  // Done now, so not again.
  const twice = await t.call("POST", `/thread/messages/${failed?.id}/retry`, undefined, { cookie });
  expect(twice.status).toBe(409);
});

test("only the latest reply that failed can be tried again", async () => {
  const model = new FakeModel([]);
  const t = await testApp(model);
  const { cookie } = await setUpOwner(t);
  await t.thread.post("one").done;
  const first = t.thread.list().find((m) => m.role === "assistant");
  model.script.push({ content: [text("Two.")], stop_reason: "max_tokens" });
  await t.thread.post("two").done;
  const second = t.thread.list().filter((m) => m.role === "assistant")[1];
  expect([first?.status, second?.status]).toEqual(["error", "error"]);
  const old = await t.call("POST", `/thread/messages/${first?.id}/retry`, undefined, { cookie });
  expect(old.status).toBe(409);
  const user = t.thread.list()[0];
  expect(t.thread.retry(user?.id as number)).toBeNull();

  // The model ended that one itself; it's asked to try again.
  model.script.push({ content: [text("Two, in full.")] });
  expect(t.thread.retry(second?.id as number)).not.toBeNull();
  await t.thread.idle();
  expect(lastUserText(model.requests.at(-1) as never)).toContain("try that reply again");
  expect(t.thread.list().at(-1)).toMatchObject({ id: second?.id, text: "Two, in full." });
});

test("a new conversation doesn't wait long for the last one's summary, which lands for the next", async () => {
  const model = new FakeModel(
    [{ content: [text("one")] }, { content: [text("two")] }, { content: [text("three")] }],
    ["<summary>Talked about one.</summary>", "<summary>Talked about one and two.</summary>"],
  );
  let release = () => {};
  const slow = new Promise<void>((r) => {
    release = r;
  });
  const create = model.create.bind(model);
  let calls = 0;
  model.create = async (p) => {
    if (calls++ === 0) await slow;
    return create(p);
  };
  const t = await testApp(model);
  t.thread.summaryWaitMs = 20;
  await t.thread.post("first").done;
  t.advance(31 * 60_000);
  await t.thread.post("second").done;
  expect(lastUserText(model.requests[1] as never)).not.toContain("Talked about one");
  release();
  await waitFor(() => summarized(t)[0]?.summarized);
  t.advance(31 * 60_000);
  await t.thread.post("third").done;
  expect(lastUserText(model.requests[2] as never)).toContain("Talked about one");
});

test("tasks a restart stopped are told in their chat, with one notification", async () => {
  const run = { title: "Book a table", goal: "Book", success_criteria: "" };
  const chat = new FakeModel([
    { content: [toolUse("run_desktop_task", run)] },
    { content: [text("Started it.")] },
    { content: [text("The brain restarted before it ran; say if I should try again.")] },
  ]);
  const t = await testApp(chat);
  // The screen is busy, so the task waits in line when the brain goes down.
  await t.tasks.lane.acquire(-5, new AbortController().signal);
  await t.thread.post("book a table").done;
  t.tasks.createBackgroundTask({ title: "Nightly check", goal: "Check", origin: "schedule" });
  const queued = t.tasks.list({ status: "active" });
  expect(queued.length).toBeGreaterThanOrEqual(1);

  const restarted = new Tasks(t.tasks.d);
  for (const q of queued) expect(restarted.get(q.id)?.status).toBe("failed");
  const sent = t.notifier.sent.length;
  restarted.recover();
  await t.thread.idle();
  const reply = t.thread.list().find((m) => m.role === "assistant" && m.taskId);
  expect(reply?.text).toContain("restarted before it ran");
  // What the task said comes before the note that it ended.
  expect(JSON.stringify(chat.requests.at(-1)?.messages.slice(-2))).toContain("the brain restarted");
  const notes = t.notifier.sent.slice(sent);
  expect(notes).toHaveLength(1);
  expect(notes[0]?.message).toContain("Book a table");
  // Once only.
  restarted.recover();
  expect(t.notifier.sent.length).toBe(sent + 1);
});

test("an effort change mid-conversation is a message where it was made, so the cache stays", async () => {
  const model = new FakeModel([
    { content: [text("one")] },
    { content: [text("two")] },
    { content: [text("three")] },
  ]);
  const t = await testApp(model);
  await t.thread.post("first").done;
  t.settings.update({ chatEffort: "medium" });
  await t.thread.post("second").done;
  await t.thread.post("third").done;
  const [one, two, three] = model.requests;
  for (const req of [one, two, three]) {
    expect(req?.output_config).toEqual({ effort: "low" });
    expect(req?.betas).toContain("mid-conversation-output-config-2026-07-01");
  }
  const marker = { role: "system", content: [], output_config: { effort: "medium" } };
  expect(two?.messages.slice(0, 1)).toEqual(one?.messages as never);
  expect(two?.messages[1]?.role).toBe("assistant");
  expect(two?.messages[2]).toEqual(marker as never);
  expect(two?.messages[3]?.role).toBe("user");
  // Set once: the next reply carries on at it.
  expect(three?.messages.filter((m) => m.role === "system")).toHaveLength(1);
  // A new conversation starts at it.
  t.advance(31 * 60_000);
  model.script.push({ content: [text("four")] });
  await t.thread.post("fourth").done;
  expect(model.requests[3]?.output_config).toEqual({ effort: "medium" });
  expect(model.requests[3]?.messages.some((m) => m.role === "system")).toBe(false);
});

test("the spending check reads today, the month and the task's spend, and keeps the reserve", async () => {
  const t = await testApp();
  t.settings.update({ limits: { taskUsd: 1, dailyUsd: 2, monthlyUsd: 3, alertReserveUsd: 0 } });
  const task = t.tasks.createBackgroundTask({ title: "Check", goal: "Check", origin: "schedule" });
  await t.tasks.idle();
  const id = (task as { id: number }).id;
  const spent = (usd: number, taskId?: number) =>
    t.spend.record({
      model: "claude-haiku-5-5",
      purpose: "task",
      usage: { input_tokens: 0, output_tokens: 0 },
      taskId,
      extraUsd: usd,
    });
  const stop = (estimate: number, withTask = false, reserve = false) => {
    try {
      t.spend.check(estimate, withTask ? { id, limitUsd: 1 } : undefined, { reserve });
      return null;
    } catch (err) {
      return (err as BudgetError).limit;
    }
  };
  // Two days ago this month, for the task; then today, for none.
  spent(0.9, id);
  t.advance(2 * 86_400_000);
  spent(1.5);
  expect(stop(0.05, true)).toBeNull();
  expect(stop(0.2, true)).toBe("task");
  expect(stop(0.6)).toBe("daily");
  t.settings.update({ limits: { dailyUsd: 10 } });
  expect(stop(0.5)).toBeNull();
  expect(stop(0.7)).toBe("monthly");
  // The last $0.50 of the month is only for alerts and the heartbeat.
  t.settings.update({ limits: { alertReserveUsd: 0.5 } });
  expect(stop(0.2)).toBe("monthly");
  expect(stop(0.5, false, true)).toBeNull();
});

test("a background task waiting on a desktop task doesn't hold a slot", async () => {
  let release = () => {};
  const screen = new Promise<void>((r) => {
    release = r;
  });
  const run = { title: "Look", goal: "Open example.com", success_criteria: "" };
  const work = new FakeModel([
    { content: [toolUse("run_desktop_task", run)] },
    {
      content: [toolUse("finish_task", { outcome: "done", summary: "It's up." })],
      wait: screen,
    },
    { content: [toolUse("finish_task", { outcome: "done", summary: "Checked.", notify: false })] },
  ]);
  const t = await testApp(new FakeModel(), work);
  t.tasks.createBackgroundTask({ title: "Check", goal: "Check", origin: "schedule" });
  await waitFor(() => work.requests.length === 2);
  const active = () => (t.tasks.pool as unknown as { active: number }).active;
  expect(active()).toBe(0);
  release();
  await t.tasks.idle();
  expect(active()).toBe(0);
  expect(work.requests).toHaveLength(3);
});

test("a task's reply that fails as it's written again still says how the task went", async () => {
  const run = { title: "Check", goal: "Open example.com", success_criteria: "" };
  const chat = new FakeModel([
    { content: [toolUse("run_desktop_task", run)] },
    { content: [text("Started it.")] },
  ]);
  const work = new FakeModel([
    { content: [toolUse("finish_task", { outcome: "done", summary: "Example.com is up." })] },
  ]);
  const t = await testApp(chat, work);
  await t.thread.post("check example.com").done;
  await t.tasks.idle();
  await t.thread.idle();
  const reply = t.thread.list().find((m) => m.role === "assistant" && m.taskId);
  expect(reply?.status).toBe("error");
  expect(reply?.text).toStartWith("Example.com is up.");
  expect(reply?.text).toContain("Something went wrong");
});
