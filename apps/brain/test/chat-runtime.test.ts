import { expect, test } from "bun:test";
import { FakeModel, text, toolUse } from "./fake-model";
import { testApp, waitFor } from "./helpers";

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
