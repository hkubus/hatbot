import { expect, test } from "bun:test";
import { FakeModel, text } from "./fake-model";
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
