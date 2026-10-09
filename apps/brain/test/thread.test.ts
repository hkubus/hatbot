import { expect, test } from "bun:test";
import { CHAT_MODEL } from "../src/agent/thread";
import { FakeModel, text, toolUse } from "./fake-model";
import { setUpOwner, testApp } from "./helpers";

const lastUserText = (req: { messages: { role: string; content: unknown }[] }) =>
  JSON.stringify(req.messages.at(-1)?.content);

test("a message gets a streamed reply, stored and searchable", async () => {
  const t = await testApp(new FakeModel([{ content: [text("Hi! I'm Hatbot.")] }]));
  const { cookie } = await setUpOwner(t);
  const res = await t.call("POST", "/thread/messages", { text: "hello there" }, { cookie });
  expect(res.status).toBe(202);
  await t.thread.idle();

  const msgs = (await (await t.call("GET", "/thread/messages", undefined, { cookie })).json()) as {
    role: string;
    text: string;
    status: string;
  }[];
  expect(msgs.map((m) => [m.role, m.text, m.status])).toEqual([
    ["user", "hello there", "done"],
    ["assistant", "Hi! I'm Hatbot.", "done"],
  ]);
  expect(t.events.map((e) => e.type)).toContain("message.delta");
  expect(t.events.at(-1)).toMatchObject({ type: "message.done", status: "done" });

  const req = t.model.requests[0];
  expect(req?.model).toBe(CHAT_MODEL);
  expect(req?.fallbacks).toBe("default");
  expect(req?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  // New episode: context block first, then the timestamped message.
  expect(lastUserText(req as never)).toContain("<memory_index>");
  expect(lastUserText(req as never)).toContain("hello there");
});

test("tool calls run and their results go back to the model", async () => {
  const model = new FakeModel([
    {
      content: [
        toolUse("memory_write", {
          path: "about-you.md",
          content: "# About you\nLikes tea",
          reason: "Note tea",
        }),
      ],
    },
    { content: [text("Noted.")] },
  ]);
  const t = await testApp(model);
  await setUpOwner(t);
  await t.thread.post("I like tea").done;

  expect(await t.memory.read("about-you.md")).toBe("# About you\nLikes tea\n");
  const second = model.requests[1];
  expect(second?.messages.at(-1)?.content).toMatchObject([
    { type: "tool_result", is_error: false },
  ]);
  // The assistant turn with the tool call is replayed exactly.
  expect(second?.messages.at(-2)).toMatchObject({
    role: "assistant",
    content: [{ type: "tool_use", name: "memory_write" }],
  });
  expect(t.events.some((e) => e.type === "memory.committed")).toBe(true);
});

test("bad tool input comes back as an error result, not a crash", async () => {
  const model = new FakeModel([
    { content: [toolUse("memory_write", { path: "x.md" })] },
    { content: [text("Sorry, retrying later.")] },
  ]);
  const t = await testApp(model);
  await t.thread.post("save something").done;
  expect(model.requests[1]?.messages.at(-1)?.content).toMatchObject([
    { type: "tool_result", is_error: true },
  ]);
});

test("within 30 minutes the episode continues; after, a new one starts with a summary", async () => {
  const model = new FakeModel(
    [{ content: [text("one")] }, { content: [text("two")] }, { content: [text("three")] }],
    ["They said one and two."],
  );
  const t = await testApp(model);
  await t.thread.post("first").done;
  t.advance(10 * 60_000);
  await t.thread.post("second").done;
  // Same episode: the history is replayed and only the new message is appended.
  expect(model.requests[1]?.messages.length).toBe(3);
  expect(lastUserText(model.requests[1] as never)).not.toContain("<context>");

  t.advance(31 * 60_000);
  await t.thread.post("third").done;
  expect(model.creates.length).toBe(1);
  expect(model.requests[2]?.messages.length).toBe(1);
  const opening = lastUserText(model.requests[2] as never);
  expect(opening).toContain("They said one and two.");
  expect(opening).toContain("Owner: second");
});

test("system prompt and tools are identical across requests (cache-stable)", async () => {
  const model = new FakeModel([{ content: [text("a")] }, { content: [text("b")] }]);
  const t = await testApp(model);
  await t.thread.post("x").done;
  t.advance(60 * 60_000);
  await t.thread.post("y").done;
  expect(JSON.stringify(model.requests[0]?.system)).toBe(JSON.stringify(model.requests[1]?.system));
  expect(JSON.stringify(model.requests[0]?.tools)).toBe(JSON.stringify(model.requests[1]?.tools));
});

test("spend is recorded, and the daily limit stops replies", async () => {
  const t = await testApp(new FakeModel([{ content: [text("ok")] }]));
  await t.thread.post("hi").done;
  // 1000 input * $2/M + 200 output * $10/M
  expect(t.spend.summary().todayUsd).toBeCloseTo(0.004, 6);

  t.settings.update({ limits: { taskUsd: 3, dailyUsd: 0.005, monthlyUsd: 200 } });
  await t.thread.post("again").done;
  const last = t.thread.list().at(-1);
  expect(last).toMatchObject({ role: "assistant", status: "error" });
  expect(last?.text).toContain("limit");
});

test("pause all stops new replies", async () => {
  const t = await testApp(new FakeModel([]));
  const { cookie } = await setUpOwner(t);
  await t.call("POST", "/pause-all", {}, { cookie });
  await t.thread.post("hi").done;
  expect(t.thread.list().at(-1)?.text).toContain("Paused");
  expect(t.model.requests.length).toBe(0);
});

test("fallback iterations are billed per model", async () => {
  const t = await testApp();
  t.spend.recordResponse({
    model: "claude-sonnet-5-5",
    purpose: "thread",
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      iterations: [
        { model: "claude-sonnet-5-5", input_tokens: 1_000_000, output_tokens: 0 },
        { model: "claude-haiku-4-5", input_tokens: 1_000_000, output_tokens: 0 },
      ],
    },
  });
  expect(t.spend.summary().todayUsd).toBeCloseTo(3, 6);
});

test("search_history finds older messages", async () => {
  const model = new FakeModel([
    { content: [text("Got it.")] },
    { content: [toolUse("search_history", { query: "wireguard" })] },
    { content: [text("Found it.")] },
  ]);
  const t = await testApp(model);
  await t.thread.post("my wireguard port is 51820").done;
  await t.thread.post("what was that port?").done;
  const result = JSON.stringify(model.requests[2]?.messages.at(-1)?.content);
  expect(result).toContain("51820");
});
