import { expect, test } from "bun:test";
import Anthropic from "@anthropic-ai/sdk";
import type { ThreadMessage } from "@hatbot/shared";
import { Chats } from "../src/agent/chats";
import {
  AnthropicModelClient,
  retryAfterMs,
  retryable,
  retryDelays,
  withRetries,
} from "../src/agent/model";
import { safeToRun } from "../src/agent/review";
import { EventBus } from "../src/events";
import { type BudgetError, requestCeiling, searchesIn } from "../src/spend";
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

test("a retry waits as long as retry-after asks, and one that asks too long isn't made", async () => {
  const limited = (headers: Record<string, string>) =>
    new Anthropic.APIError(
      429,
      { type: "error", error: { type: "rate_limit_error", message: "slow down" } },
      undefined,
      new Headers(headers),
      "rate_limit_error",
    );
  expect(retryAfterMs(limited({ "retry-after": "2" }))).toBe(2000);
  expect(retryAfterMs(limited({ "retry-after-ms": "150" }))).toBe(150);
  expect(
    retryAfterMs(limited({ "retry-after": "Fri, 09 Oct 2026 12:00:30 GMT" }), 0),
  ).toBeGreaterThan(0);
  expect(retryAfterMs(limited({}))).toBeNull();

  let tries = 0;
  const started = Date.now();
  const twice = () =>
    ++tries < 2 ? Promise.reject(limited({ "retry-after-ms": "60" })) : Promise.resolve("ok");
  expect(await withRetries(twice, {}, [0, 0])).toBe("ok");
  expect(Date.now() - started).toBeGreaterThanOrEqual(55);

  tries = 0;
  const later = () => {
    tries++;
    return Promise.reject(limited({ "retry-after": "3600" }));
  };
  await expect(withRetries(later, {}, [0, 0])).rejects.toBeInstanceOf(Anthropic.APIError);
  expect(tries).toBe(1);
});

test("a stream is tried at most three times in all, and a failed try's usage is reported", async () => {
  const overloaded = new Anthropic.APIError(
    undefined,
    { type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
    undefined,
    undefined,
    "overloaded_error",
  );
  const options: unknown[] = [];
  const client = new AnthropicModelClient("sk-test");
  (client as unknown as { client: unknown }).client = {
    beta: {
      messages: {
        stream: (_params: unknown, opts: unknown) => {
          options.push(opts);
          return {
            async *[Symbol.asyncIterator]() {
              yield {
                type: "message_start",
                message: {
                  model: "claude-opus-5-5",
                  usage: { input_tokens: 500, output_tokens: 1 },
                },
              };
              yield {
                type: "message_delta",
                delta: {},
                usage: { input_tokens: null, output_tokens: 40 },
              };
              throw overloaded;
            },
            finalMessage: async () => ({}),
          };
        },
      },
    },
  };
  const failed: { model: string; output: number }[] = [];
  const saved = retryDelays.ms;
  retryDelays.ms = [0, 0];
  try {
    await expect(
      client.stream(
        { model: "claude-opus-5-5", max_tokens: 10, messages: [] },
        {
          onFailedUsage: (model, usage) => failed.push({ model, output: usage.output_tokens }),
        },
      ),
    ).rejects.toBe(overloaded);
  } finally {
    retryDelays.ms = saved;
  }
  expect(options).toHaveLength(3);
  expect(options[0]).toMatchObject({ maxRetries: 0 });
  expect(failed).toEqual(Array(3).fill({ model: "claude-opus-5-5", output: 40 }));
});

test("a reply whose stream failed partway bills that try too", async () => {
  const model = new FakeModel([
    {
      content: [text("The whole answer.")],
      failedWith: "The who",
      failedUsage: { input_tokens: 1000, output_tokens: 0 },
    },
  ]);
  const t = await testApp(model);
  await t.thread.post("hi").done;
  const rows = t.db.query("SELECT input_tokens FROM spend_ledger WHERE purpose = 'thread'").all();
  expect(rows).toHaveLength(2);
});

test("a reply being written shows its text so far, is saved as it goes, and a restart keeps it", async () => {
  let release = () => {};
  let release2 = () => {};
  const model = new FakeModel([
    {
      content: [text("Checking the disks."), toolUse("memory_list", {})],
      wait: new Promise<void>((r) => {
        release = r;
      }),
    },
    {
      content: [text("All fine.")],
      wait: new Promise<void>((r) => {
        release2 = r;
      }),
    },
  ]);
  const t = await testApp(model);
  const { done } = t.thread.post("check the disks");
  await waitFor(() => model.requests.length);
  t.advance(5000);
  release();
  await waitFor(() => model.requests.length === 2);
  const reply = t.thread.list().at(-1) as ThreadMessage;
  expect(reply).toMatchObject({ status: "streaming", text: "Checking the disks." });
  const saved = () =>
    t.db
      .query<{ text: string; status: string }, [number]>(
        "SELECT text, status FROM messages WHERE id = ?",
      )
      .get(reply.id);
  expect(saved()?.text).toBe("Checking the disks.");
  // Each delta says where it starts, so an app that loaded the reply mid-way doesn't add it twice.
  const first = t.events.find((e) => e.type === "message.delta" && e.id === reply.id);
  expect(first).toMatchObject({ at: 0, text: "Checking the disks." });

  // The brain restarts now: the reply keeps what was saved, and says it was cut off.
  t.db
    .query(
      "INSERT INTO messages (conversation_id, role, kind, text, status, created_at) VALUES (1, 'assistant', 'text', '', 'streaming', ?)",
    )
    .run(new Date().toISOString());
  new Chats({
    db: t.db,
    memory: t.memory,
    events: new EventBus(),
    spend: t.spend,
    settings: t.settings,
    model,
    plugins: t.plugins,
    bots: t.bots,
  });
  expect(saved()).toEqual({
    text: "Checking the disks.\n\n---\n\n_This reply was cut off._",
    status: "error",
  });
  const empty = t.db
    .query<{ text: string }, []>("SELECT text FROM messages ORDER BY id DESC LIMIT 1")
    .get();
  expect(empty?.text).toBe("_This reply was cut off._");
  release2();
  await done;
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
  expect(lastUserText(chat.requests.at(-1) as never)).toContain("the brain restarted");
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

test("the most a request may cost: uncached input as a cache write, all of max_tokens, every search", () => {
  // Opus 5.5: 100k prompt, 60k of it cached, written for an hour; 32k out; 8 searches.
  const usd = requestCeiling("claude-opus-5-5", {
    prompt: 100_000,
    cached: 60_000,
    write: "1h",
    maxTokens: 32_000,
    webSearches: 8,
  });
  expect(usd).toBeCloseTo((40_000 * 8 + 60_000 * 0.2 + 32_000 * 20) / 1e6 + 0.08, 9);
  // No cache breakpoints: plain input.
  expect(requestCeiling("claude-haiku-5-5", { prompt: 1000, maxTokens: 4000 })).toBeCloseTo(
    (1000 * 0.1 + 4000 * 0.5) / 1e6,
    9,
  );
  expect(
    searchesIn([
      { name: "web_search", max_uses: 8 },
      { name: "web_fetch", max_uses: 8 },
    ]),
  ).toBe(8);
});

test("requests in flight hold what they may cost, so ones made at once can't pass a limit together", async () => {
  const t = await testApp();
  t.settings.update({ limits: { taskUsd: 3, dailyUsd: 1, monthlyUsd: 200, alertReserveUsd: 0 } });
  const first = t.spend.hold(0.6);
  expect(() => t.spend.hold(0.6)).toThrow("Today's $1 limit");
  first();
  const second = t.spend.hold(0.6);
  second();
  // A task's own requests in flight count against its limit too.
  const task = { id: 7, limitUsd: 0.5 };
  const one = t.spend.hold(0.3, task);
  expect(() => t.spend.hold(0.3, task)).toThrow("over its $0.5 limit");
  one();
});

test("the check keeps today's and the month's spend up to date without summing them again", async () => {
  const t = await testApp();
  t.settings.update({ limits: { taskUsd: 3, dailyUsd: 1, monthlyUsd: 200, alertReserveUsd: 0 } });
  t.spend.check(0.5);
  // A row the ledger gets some other way is counted on the next check.
  t.db
    .query(
      `INSERT INTO spend_ledger (created_at, model, purpose, input_tokens, cache_write_5m_tokens,
       cache_write_1h_tokens, cache_read_tokens, output_tokens, cost_usd) VALUES (?, 'x', 'test', 0, 0, 0, 0, 0, 0.8)`,
    )
    .run(new Date(Date.parse("2026-10-09T12:00:00Z")).toISOString());
  expect(() => t.spend.check(0.5)).toThrow("Today's $1 limit");
  expect(t.spend.summary().monthUsd).toBeCloseTo(0.8, 9);
  // A new day starts from nothing.
  t.advance(86_400_000);
  t.spend.check(0.5);
});

test("a task's limit covers the tasks it started; its cost shows theirs too", async () => {
  const t = await testApp();
  const add = (parent: number | null) =>
    t.db
      .query<{ id: number }, [number | null]>(
        `INSERT INTO tasks (title, goal, success_criteria, origin, lane, model, status, budget_usd, created_at, parent_id)
         VALUES ('Research a laptop', 'g', '', 'chat', 'background', 'claude-opus-5-5', 'running', 3, '2026-10-09T12:00:00Z', ?)
         RETURNING id`,
      )
      .get(parent)?.id as number;
  const root = add(null);
  const asked = add(root);
  const screen = add(asked);
  const spent = (usd: number, taskId: number) =>
    t.spend.record({
      model: "claude-haiku-5-5",
      purpose: "task",
      usage: { input_tokens: 0, output_tokens: 0 },
      taskId,
      extraUsd: usd,
    });
  spent(1, root);
  spent(1, asked);
  spent(0.9, screen);
  expect(t.tasks.rootOf(screen)).toBe(root);
  expect(t.tasks.budget(screen)).toBe(3);
  // Each would have room on its own; together the tree is at its limit.
  const limit = { id: screen, limitUsd: t.tasks.budget(screen) };
  expect(() => t.spend.check(0.2, limit)).toThrow(`task #${root}, which started it`);
  expect(t.tasks.get(root)?.costUsd).toBeCloseTo(2.9, 9);
  expect(t.tasks.get(asked)?.costUsd).toBeCloseTo(1.9, 9);
  expect(t.tasks.budgetAsk(screen, 3).summary).toBe(
    `Let task #${root} and the tasks it started spend $3 more`,
  );
  t.tasks.raiseBudget(screen, 3);
  expect(t.tasks.budget(root)).toBe(6);
  t.spend.check(0.2, { id: screen, limitUsd: t.tasks.budget(screen) });
});

test("an Opus reply that could pass the limit with all its output isn't started", async () => {
  const model = new FakeModel([{ content: [text("ok")] }]);
  const t = await testApp(model);
  t.settings.update({
    chatModel: "claude-opus-5-5",
    limits: { taskUsd: 3, dailyUsd: 0.5, monthlyUsd: 200, alertReserveUsd: 0 },
  });
  await t.thread.post("hi").done;
  // 32k output tokens at $20 a million is $0.64 alone.
  expect(model.requests).toHaveLength(0);
  expect(t.thread.list().at(-1)?.text).toContain("Today's $0.5 limit");
});

test("summaries and Haiku's reviews wait while the limits are spent", async () => {
  const model = new FakeModel([{ content: [text("one")] }], ["<summary>S</summary>"]);
  const t = await testApp(model);
  await t.thread.post("first").done;
  t.settings.update({
    limits: { taskUsd: 3, dailyUsd: 0.000001, monthlyUsd: 200, alertReserveUsd: 0 },
  });
  t.advance(31 * 60_000);
  for (let i = 0; i < 4; i++) await t.thread.sweep();
  expect(model.creates).toHaveLength(0);
  expect(summarized(t)).toEqual([{ id: 1, summarized: 0 }]);
  const review = await safeToRun(
    { model, spend: t.spend },
    {},
    { ownerSaid: "restart it", goal: "restart nginx", sources: [] },
    { tool: "ssh_exec", input: {}, what: "Restart nginx", why: "It changes a host." },
  );
  expect(review.safe).toBe(false);
  expect(model.creates).toHaveLength(0);
  t.settings.update({ limits: { taskUsd: 3, dailyUsd: 10, monthlyUsd: 200, alertReserveUsd: 0 } });
  await t.thread.sweep();
  expect(summarized(t)).toEqual([{ id: 1, summarized: 1 }]);
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
