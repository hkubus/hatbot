import { expect, test } from "bun:test";
import Anthropic from "@anthropic-ai/sdk";
import { retryable, withRetries } from "../src/agent/model";
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
  expect(opening).toContain("Owner: first");
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
