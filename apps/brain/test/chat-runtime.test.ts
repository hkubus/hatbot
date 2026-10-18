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
import { EventBus } from "../src/events";
import { type BudgetError, estimateTokens, requestCeiling, searchesIn } from "../src/spend";
import { Tasks } from "../src/tasks/service";
import { FakeModel, text, toolUse } from "./fake-model";
import {
  bot,
  lastUserText,
  requested,
  setUpOwner,
  type TestApp,
  testApp,
  unmarked,
} from "./helpers";

const overloaded = new Anthropic.APIError(
  undefined,
  { type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
  undefined,
  undefined,
  "overloaded_error",
);

/** `usd` of spend in the ledger now, for a task or none. */
const spent = (t: TestApp, usd: number, taskId?: number) =>
  t.spend.record({
    model: "claude-haiku-5-5",
    purpose: "task",
    usage: { input_tokens: 0, output_tokens: 0 },
    taskId,
    extraUsd: usd,
  });

const summarized = (t: TestApp) =>
  t.db.query<{ id: number; summarized: number }, []>("SELECT id, summarized FROM episodes").all();

test("a summary waits for an idle conversation with no reply running, is tried again when it can't be written, and the next conversation doesn't wait on it", async () => {
  const slow = Promise.withResolvers<void>();
  const model = new FakeModel(
    [
      { content: [text("Done at last.")], wait: slow.promise },
      { content: [text("two")] },
      { content: [text("three")] },
    ],
    ["", "<summary>Talked about one.</summary>", "", "", ""],
  );
  const t = await testApp(model);
  const asked = requested(model);
  const { done } = t.thread.post("a slow one");
  await asked;
  t.advance(31 * 60_000);
  await t.thread.sweep();
  expect(model.creates).toHaveLength(0);
  slow.resolve();
  await done;
  // It just ended: active again, so not idle yet.
  await t.thread.sweep();
  expect(model.creates).toHaveLength(0);

  // A spent limit: the summary waits, and that isn't a failed try.
  const limits = t.settings.get().limits;
  t.settings.update({ limits: { dailyUsd: 0.000001, alertReserveUsd: 0 } });
  t.advance(31 * 60_000);
  for (let i = 0; i < 4; i++) await t.thread.sweep();
  expect(model.creates).toHaveLength(0);
  t.settings.update({ limits });
  // A failed try.
  await t.thread.sweep();
  expect(summarized(t)).toEqual([{ id: 1, summarized: 0 }]);

  // The next conversation starts without a slow summary, which lands for the one after.
  const gate = Promise.withResolvers<void>();
  const create = model.create.bind(model);
  model.create = async (p) => {
    await gate.promise;
    return create(p);
  };
  t.thread.summaryWaitMs = 0;
  await t.thread.post("second").done;
  expect(model.requests[1]?.messages).toHaveLength(1);
  expect(lastUserText(model.requests[1])).not.toContain("Talked about one");
  gate.resolve();
  await t.thread.summarize(1);
  expect(summarized(t)).toEqual([
    { id: 1, summarized: 1 },
    { id: 2, summarized: 0 },
  ]);

  // Given up after three failed tries.
  t.advance(31 * 60_000);
  for (let i = 0; i < 3; i++) await t.thread.sweep();
  expect(summarized(t).at(-1)).toEqual({ id: 2, summarized: 1 });
  await t.thread.sweep();
  expect(model.creates).toHaveLength(5);
  await t.thread.post("third").done;
  expect(lastUserText(model.requests[2])).toContain("Talked about one");
});

test("a stream that fails is tried three times at most, after retry-after; not once stopped, nor when retry-after asks too long", async () => {
  expect(retryable(overloaded)).toBe(true);
  expect(retryable(new Anthropic.APIConnectionError({ message: "reset" }))).toBe(true);
  expect(retryable(new Anthropic.APIUserAbortError())).toBe(false);
  expect(retryable(new Anthropic.APIError(400, undefined, "bad", undefined))).toBe(false);

  let tries = 0;
  const failing =
    (times: number, err: unknown = overloaded) =>
    () =>
      ++tries <= times ? Promise.reject(err) : Promise.resolve("ok");
  let retries = 0;
  expect(await withRetries(failing(2), { onRetry: () => retries++ }, [0, 0])).toBe("ok");
  expect([tries, retries]).toEqual([3, 2]);
  tries = 0;
  await expect(withRetries(failing(3), {}, [0, 0])).rejects.toBe(overloaded);
  expect(tries).toBe(3);
  tries = 0;
  const stopped = new AbortController();
  stopped.abort();
  await expect(withRetries(failing(3), { signal: stopped.signal }, [0, 0])).rejects.toBe(
    overloaded,
  );
  expect(tries).toBe(1);

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
  const now = Date.parse("2026-10-09T12:00:00Z");
  expect(retryAfterMs(limited({ "retry-after": "Fri, 09 Oct 2026 12:00:30 GMT" }), now)).toBe(
    30_000,
  );
  expect(retryAfterMs(limited({}))).toBeNull();
  // It waits as long as retry-after asks, not its own shorter delay; the wait itself is skipped.
  const waits: number[] = [];
  tries = 0;
  expect(
    await withRetries(failing(1, limited({ "retry-after-ms": "60" })), {}, [0, 0], async (ms) => {
      waits.push(ms);
    }),
  ).toBe("ok");
  expect(waits).toEqual([60]);
  tries = 0;
  await expect(
    withRetries(failing(3, limited({ "retry-after": "3600" })), {}, [0, 0]),
  ).rejects.toBeInstanceOf(Anthropic.APIError);
  expect(tries).toBe(1);

  // The client tries a stream three times in all, the SDK not at all, and reports each try's usage.
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

test("a reply as it's written: shown and saved so far, started over when its stream is tried again, with the failed try billed, and kept through a restart", async () => {
  const first = Promise.withResolvers<void>();
  const second = Promise.withResolvers<void>();
  const model = new FakeModel([
    {
      content: [text("The whole answer.")],
      failedWith: "The who",
      failedUsage: { input_tokens: 1000, output_tokens: 0 },
    },
    {
      content: [text("Checking the disks."), toolUse("memory_list", {})],
      wait: first.promise,
    },
    { content: [text("All fine.")], wait: second.promise },
  ]);
  const t = await testApp(model);

  // The stream failed after "The who" and was tried again: the reply starts over, and both tries are billed.
  await t.thread.post("hi").done;
  const answer = t.thread.list().find((m) => m.role === "assistant");
  expect(answer?.text).toBe("The whole answer.");
  const at = t.events.findIndex((e) => e.type === "message.rewrite" && e.id === answer?.id);
  expect(at).toBeGreaterThan(-1);
  const after = t.events
    .slice(at)
    .flatMap((e) => (e.type === "message.delta" && e.id === answer?.id ? [e.text] : []));
  expect(after.join("")).toBe("The whole answer.");
  const rows = t.db.query("SELECT input_tokens FROM spend_ledger WHERE purpose = 'thread'").all();
  expect(rows).toHaveLength(2);

  const asked = requested(model, 2);
  const { done } = t.thread.post("check the disks");
  await asked;
  t.advance(5000);
  const again = requested(model, 3);
  first.resolve();
  await again;
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
  const delta = t.events.find((e) => e.type === "message.delta" && e.id === reply.id);
  expect(delta).toMatchObject({ at: 0, text: "Checking the disks." });

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
  second.resolve();
  await done;
});

test("only the latest reply that failed can be tried again; it's written in place from the turns it had", async () => {
  const model = new FakeModel([]);
  const t = await testApp(model);
  const { cookie } = await setUpOwner(t);
  const retry = (id?: number) =>
    t.call("POST", `/thread/messages/${id}/retry`, undefined, { cookie });
  await t.thread.post("one").done;
  const first = t.thread.list().find((m) => m.role === "assistant");
  model.script.push({ content: [text("Two.")], stop_reason: "max_tokens" });
  await t.thread.post("two").done;
  const second = t.thread.list().at(-1);
  expect([first?.status, second?.status]).toEqual(["error", "error"]);
  expect((await retry(first?.id)).status).toBe(409);
  expect(t.thread.retry(t.thread.list()[0]?.id as number)).toBeNull();

  // The model ended that one itself: it goes on from what it wrote.
  model.script.push({ content: [text("Two, in full.")] });
  expect((await retry(second?.id)).status).toBe(202);
  await t.thread.idle();
  const [cut, again] = model.requests.slice(-2);
  expect(again?.messages.length).toBeGreaterThan(cut?.messages.length as number);
  expect(t.thread.list().at(-1)).toMatchObject({
    id: second?.id,
    text: "Two, in full.",
    status: "done",
    editedAt: null,
  });
  expect(t.events.some((e) => e.type === "message.rewrite" && e.id === second?.id)).toBe(true);
  // Done now, so not again.
  expect((await retry(second?.id)).status).toBe(409);

  // A request that failed goes again as it was: the owner's message once, nothing added.
  await t.thread.post("three").done;
  const third = t.thread.list().at(-1);
  expect(third?.status).toBe("error");
  model.script.push({ content: [text("3.")] });
  expect((await retry(third?.id)).status).toBe(202);
  await t.thread.idle();
  expect(unmarked(model.requests.at(-1)?.messages)).toEqual(
    unmarked(model.requests.at(-2)?.messages),
  );
  expect(t.thread.list().filter((m) => m.text === "three")).toHaveLength(1);
  expect(t.thread.list().at(-1)).toMatchObject({ id: third?.id, text: "3.", status: "done" });
});

test("the spending check stops at a task tree's, today's and the month's limit, counting what's in flight and keeping the reserve", async () => {
  const t = await testApp();
  t.settings.update({ limits: { dailyUsd: 2, monthlyUsd: 4, alertReserveUsd: 0 } });
  const add = (parent: number | null) =>
    t.db
      .query<{ id: number }, [number | null]>(
        `INSERT INTO tasks (title, goal, success_criteria, origin, lane, model, status, budget_usd, created_at, parent_id)
         VALUES ('Research a laptop', 'g', '', 'chat', 'background', 'claude-opus-5-5', 'running', 1, '2026-10-09T12:00:00Z', ?)
         RETURNING id`,
      )
      .get(parent)?.id as number;
  const stop = (estimate: number, task?: { id: number; limitUsd: number }, reserve = false) => {
    try {
      t.spend.check(estimate, task, { reserve });
      return null;
    } catch (err) {
      return (err as BudgetError).limit;
    }
  };

  // A task's limit covers the tasks it started; its cost shows theirs too.
  const root = add(null);
  const child = add(root);
  spent(t, 0.5, root);
  spent(t, 0.4, child);
  expect(t.tasks.get(root)?.costUsd).toBeCloseTo(0.9, 9);
  const tree = () => ({ id: child, limitUsd: t.tasks.budget(child) });
  expect(stop(0.05, tree())).toBeNull();
  expect(stop(0.2, tree())).toBe("task");
  const held = t.spend.hold(0.05, tree());
  expect(stop(0.06, tree())).toBe("task");
  held();
  t.tasks.raiseBudget(child, 3);
  expect(t.tasks.budget(root)).toBe(4);
  expect(stop(0.2, tree())).toBeNull();

  // Today's, with what's in flight.
  spent(t, 1);
  expect(stop(0.05)).toBeNull();
  expect(stop(0.2)).toBe("daily");
  const inFlight = t.spend.hold(0.05);
  expect(stop(0.06)).toBe("daily");
  inFlight();
  // A new day starts from nothing, and a row the ledger gets some other way is counted.
  t.advance(86_400_000);
  expect(stop(0.6)).toBeNull();
  t.db
    .query(
      `INSERT INTO spend_ledger (created_at, model, purpose, input_tokens, cache_write_5m_tokens,
       cache_write_1h_tokens, cache_read_tokens, output_tokens, cost_usd) VALUES (?, 'x', 'test', 0, 0, 0, 0, 0, 1.5)`,
    )
    .run("2026-10-10T12:00:00.000Z");
  expect(stop(0.6)).toBe("daily");

  // The month's, and its last $0.50 only for alerts and the heartbeat.
  t.settings.update({ limits: { dailyUsd: 10 } });
  expect(stop(0.5)).toBeNull();
  expect(stop(0.7)).toBe("monthly");
  t.settings.update({ limits: { alertReserveUsd: 0.5 } });
  expect(stop(0.2)).toBe("monthly");
  expect(stop(0.5, undefined, true)).toBeNull();
});

test("the most a request may cost: uncached input as a cache write, all its output and searches, a fallback's answer, files by size", async () => {
  // Opus 5.5: 100k prompt, 60k of it cached, written for an hour; 32k out; 8 searches.
  const r = { prompt: 100_000, cached: 60_000, write: "1h" as const, maxTokens: 32_000 };
  expect(requestCeiling("claude-opus-5-5", { ...r, webSearches: 8 })).toBeCloseTo(
    (40_000 * 8 + 60_000 * 0.2 + 32_000 * 20) / 1e6 + 0.08,
    9,
  );
  // Opus 5.5 reads the prompt and declines; Opus 5 or Opus 4.8 answers at $5/$25, with nothing cached.
  expect(requestCeiling("claude-opus-5-5", { ...r, fallbacks: true })).toBeCloseTo(
    (40_000 * 8 + 60_000 * 0.2) / 1e6 + (100_000 * 10 + 32_000 * 25) / 1e6,
    9,
  );
  // Haiku 5.5 has no fallback; with no cache breakpoints, it's plain input.
  expect(
    requestCeiling("claude-haiku-5-5", { prompt: 1000, maxTokens: 4000, fallbacks: true }),
  ).toBeCloseTo((1000 * 0.1 + 4000 * 0.5) / 1e6, 9);
  expect(
    searchesIn([
      { name: "web_search", max_uses: 8 },
      { name: "web_fetch", max_uses: 8 },
    ]),
  ).toBe(8);
  // Images and PDFs count by their size, not their base64: 100 + 200 of text, an image, a 768 KB PDF.
  const mb = "A".repeat(1024 * 1024);
  const tokens = estimateTokens([
    {
      role: "user",
      content: [
        { type: "text", text: "x".repeat(350) },
        { type: "image", source: { type: "base64", media_type: "image/png", data: mb } },
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: mb } },
        {
          type: "document",
          source: { type: "text", media_type: "text/plain", data: "y".repeat(700) },
        },
      ],
    },
  ]);
  expect(tokens).toBeGreaterThan(300 + 1600 + 768 * 25);
  expect(tokens).toBeLessThan(300 + 1600 + 768 * 25 + 50);

  // The chat holds that, and its cache's hour runs from when the request was sent.
  const sent = Promise.withResolvers<void>();
  const model = new FakeModel([
    {
      content: [text("Hi.")],
      usage: {
        cache_creation_input_tokens: 80_000,
        cache_creation: { ephemeral_1h_input_tokens: 80_000, ephemeral_5m_input_tokens: 0 },
      },
      wait: sent.promise,
    },
    { content: [text("Again.")] },
  ]);
  const t = await testApp(model);
  t.settings.update({ chatModel: "claude-opus-5-5" });
  const holds: number[] = [];
  const hold = t.spend.hold.bind(t.spend);
  t.spend.hold = (usd, ...rest) => {
    holds.push(usd);
    return hold(usd, ...rest);
  };
  // About 80k tokens: what the first request wrote to the cache.
  const asked = requested(model);
  const first = t.thread.post(`Read this: ${"lorem ".repeat(47_000)}`).done;
  await asked;
  // A reply that takes 35 minutes, then a message 26 minutes after it: an hour after the request was
  // sent, its cache entry is gone.
  t.advance(35 * 60_000);
  sent.resolve();
  await first;
  t.advance(26 * 60_000);
  await t.thread.post("again").done;
  expect(new Set(t.thread.list().map((m) => m.episodeId)).size).toBe(1);
  // Each may cost 80k tokens of prompt written to the cache by Opus 5.5, which declines, and again by
  // Opus 5, which answers with all of its output and searches.
  const most = (80_000 * 8 + 80_000 * 10) / 1e6 + 0.85;
  expect(holds[0]).toBeGreaterThan(most);
  // The second was sent over an hour after the first: none of it is in the cache.
  expect(holds[1]).toBeGreaterThan(most);
});

test("an effort change mid-conversation is a message where it was made, so the cache stays", async () => {
  const model = new FakeModel([
    { content: [text("one")] },
    { content: [text("two")] },
    { content: [text("three")] },
    { content: [text("four")] },
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
  expect(unmarked(two?.messages.slice(0, 1))).toEqual(unmarked(one?.messages));
  expect(two?.messages[1]?.role).toBe("assistant");
  expect(two?.messages[2]).toEqual({
    role: "system",
    content: [],
    output_config: { effort: "medium" },
  } as never);
  expect(two?.messages[3]?.role).toBe("user");
  // Set once: the next reply carries on at it.
  expect(three?.messages.filter((m) => m.role === "system")).toHaveLength(1);
  // A new conversation starts at it.
  t.advance(31 * 60_000);
  await t.thread.post("fourth").done;
  expect(model.requests[3]?.output_config).toEqual({ effort: "medium" });
  expect(model.requests[3]?.messages.some((m) => m.role === "system")).toBe(false);
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

test("a background task waiting on a desktop task doesn't hold a slot", async () => {
  const screen = Promise.withResolvers<void>();
  const run = { title: "Look", goal: "Open example.com", success_criteria: "" };
  const work = new FakeModel([
    { content: [toolUse("run_desktop_task", run)] },
    {
      content: [toolUse("finish_task", { outcome: "done", summary: "It's up." })],
      wait: screen.promise,
    },
    { content: [toolUse("finish_task", { outcome: "done", summary: "Checked.", notify: false })] },
  ]);
  const t = await testApp(new FakeModel(), work);
  const asked = requested(work, 2);
  t.tasks.createBackgroundTask({ title: "Check", goal: "Check", origin: "schedule" });
  await asked;
  const active = () => (t.tasks.pool as unknown as { active: number }).active;
  expect(active()).toBe(0);
  screen.resolve();
  await t.tasks.idle();
  expect(active()).toBe(0);
  expect(work.requests).toHaveLength(3);
});

test("a task's reply that fails as it's written still says how the task went", async () => {
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
});

test("a task a deleted bot started ends with its result; the bot isn't asked again", async () => {
  const slow = Promise.withResolvers<void>();
  const chat = new FakeModel([
    { content: [toolUse("run_task", { title: "Look", goal: "Look at the NAS" })] },
    { content: [text("On it.")] },
  ]);
  const work = new FakeModel([
    {
      wait: slow.promise,
      content: [
        toolUse("finish_task", { outcome: "done", summary: "The NAS is fine.", notify: true }),
      ],
    },
  ]);
  const t = await testApp(chat, work);
  const coder = bot(t, "Coder");
  const thread = t.chats.direct(coder.id);
  await thread.post("look at the nas").done;
  const reply = thread.list().at(-1) as ThreadMessage;
  t.bots.delete(coder.id);
  slow.resolve();
  await t.tasks.idle();
  await thread.idle();
  expect(chat.requests).toHaveLength(2);
  expect(thread.list().find((m) => m.id === reply.id)?.text).toStartWith("The NAS is fine.");
  // Nor can a failed reply of its be written again.
  t.db.query("UPDATE messages SET status = 'error' WHERE id = ?").run(reply.id);
  expect(thread.retry(reply.id)).toBeNull();
});
