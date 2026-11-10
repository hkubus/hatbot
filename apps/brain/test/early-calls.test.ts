import { expect, test } from "bun:test";
import Anthropic from "@anthropic-ai/sdk";
import { AnthropicModelClient } from "@hatbot/plugin-anthropic";
import { definePlugin, ready, tool } from "@hatbot/plugin-sdk";
import { z } from "zod";
import { inBatches, startEarly } from "../src/agent/tools";
import { FakeModel, text, toolUse } from "./fake-model";
import { testApp } from "./helpers";
import { finish } from "./plugin-helpers";

type Block = Anthropic.Beta.BetaContentBlock;
type Call = Anthropic.Beta.BetaToolUseBlock;

function lab(log: string[], onRead = () => {}) {
  return definePlugin({
    id: "lab",
    name: "Lab",
    description: "A fake homelab",
    config: z.object({}),
    start: () =>
      ready([
        tool({
          name: "lab_df",
          description: "A host's disk use",
          access: "read",
          schema: z.object({ host: z.string() }),
          run: async ({ host }) => {
            log.push(`df ${host}`);
            onRead();
            return `${host}: 85% full`;
          },
        }),
        tool({
          name: "lab_restart",
          description: "Restart a host",
          access: "write",
          schema: z.object({ host: z.string() }),
          run: async ({ host }) => {
            log.push(`restart ${host}`);
            return "Restarted.";
          },
        }),
      ]),
  });
}

const resultsOf = (req: { messages: { content: unknown }[] } | undefined) =>
  req?.messages.at(-1)?.content as { tool_use_id: string; content: string; is_error?: boolean }[];

test("a reply's lookups start as each completes, until any other call or server tool; a retry starts over", () => {
  const started: string[] = [];
  const early = startEarly(
    (c) => c.name === "read",
    async (c) => started.push(c.id),
  );
  const blocks = [
    text("Looking."),
    { type: "thinking", thinking: "", signature: "" },
    toolUse("read", {}, "a"),
    toolUse("read", {}, "b"),
    toolUse("write", {}, "c"),
    toolUse("read", {}, "d"),
  ] as Block[];
  for (const b of blocks) early.onBlock(b);
  expect(started).toEqual(["a", "b"]);
  expect(early.started({ id: "b" } as Call)).toBeDefined();
  expect(early.started({ id: "d" } as Call)).toBeUndefined();

  early.onRetry();
  expect(early.started({ id: "a" } as Call)).toBeUndefined();
  early.onBlock({ type: "server_tool_use", id: "s", name: "web_search", input: {} } as Block);
  early.onBlock(toolUse("read", {}, "e"));
  expect(started).toEqual(["a", "b"]);
});

test("a task's lookup runs while the rest of its reply streams, and keeps its result when the reply is cut off", async () => {
  const log: string[] = [];
  const read = Promise.withResolvers<void>();
  const again = Promise.withResolvers<void>();
  let reads = 0;
  const work = new FakeModel([
    // The reply ends only once the lookup has run.
    {
      content: [text("Checking."), toolUse("lab_df", { host: "nas" }, "df1"), text("Then more.")],
      stop_reason: "tool_use",
      rest: read.promise,
    },
    {
      content: [
        toolUse("lab_df", { host: "web" }, "df2"),
        toolUse("lab_restart", { host: "web" }, "re"),
      ],
      stop_reason: "max_tokens",
      rest: again.promise,
    },
    finish("The nas is 85% full."),
  ]);
  const t = await testApp(new FakeModel(), work, {}, [
    lab(log, () => (++reads === 1 ? read : again).resolve()),
  ]);
  await t.plugins.update("lab", { enabled: true });
  const task = t.tasks.createBackgroundTask({
    title: "Disks",
    goal: "Check disks",
    origin: "chat",
  });
  await t.tasks.idle();

  expect(t.tasks.get(task?.id as number)?.status).toBe("done");
  expect(log).toEqual(["df nas", "df web"]);
  expect(resultsOf(work.requests[1])).toMatchObject([
    { tool_use_id: "df1", content: "nas: 85% full" },
  ]);
  expect(resultsOf(work.requests[2])).toMatchObject([
    { tool_use_id: "df2", content: "web: 85% full" },
    { tool_use_id: "re", is_error: true },
  ]);
  // Its note comes before the lookup, as it was written.
  const steps = t.tasks.steps(task?.id as number).map((s) => s.detail);
  expect(steps.indexOf("Checking.")).toBeLessThan(steps.findIndex((d) => d.includes("lab_df")));
});

test("the chat's lookup runs while its reply streams, but waits for the end where another model may take over", async () => {
  const log: string[] = [];
  const read = Promise.withResolvers<void>();
  let streaming = false;
  const during: boolean[] = [];
  const chat = new FakeModel([
    { content: [toolUse("lab_df", { host: "nas" }), text("…")], rest: read.promise },
    { content: [text("85% full.")] },
    { content: [text("85% full too.")] },
  ]);
  chat.route = () => {
    streaming = true;
    if (chat.requests.length !== 3) return undefined;
    return {
      content: [toolUse("lab_df", { host: "web" }), text("…")],
      // Ends once what runs on its own has: a lookup started early would have run first.
      rest: new Promise((r) => setImmediate(r)).then(() => {
        streaming = false;
      }),
    };
  };
  const t = await testApp(chat, new FakeModel(), {}, [
    lab(log, () => {
      during.push(streaming);
      read.resolve();
    }),
  ]);
  await t.plugins.update("lab", { enabled: true });
  await t.thread.post("how full is the nas?").done;
  t.settings.update({ chatModel: "claude-opus-5-5" });
  t.advance(60_000);
  await t.thread.post("and web?").done;

  expect(chat.requests[2]).toMatchObject({ fallbacks: "default" });
  expect(log).toEqual(["df nas", "df web"]);
  expect(during).toEqual([true, false]);
});

test("the Anthropic client hands over each block once it's complete, a call with its input, before the message ends", async () => {
  const got = Promise.withResolvers<void>();
  const sse = (events: object[]) =>
    events
      .map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`)
      .join("");
  const body = new ReadableStream<Uint8Array>({
    async start(c) {
      const send = (events: object[]) => c.enqueue(new TextEncoder().encode(sse(events)));
      send([
        {
          type: "message_start",
          message: {
            id: "msg_1",
            type: "message",
            role: "assistant",
            model: "claude-haiku-5-5",
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 1 },
          },
        },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Checking." } },
        { type: "content_block_stop", index: 0 },
        {
          type: "content_block_start",
          index: 1,
          content_block: { type: "tool_use", id: "toolu_1", name: "lab_df", input: {} },
        },
        {
          type: "content_block_delta",
          index: 1,
          delta: { type: "input_json_delta", partial_json: '{"host":' },
        },
        {
          type: "content_block_delta",
          index: 1,
          delta: { type: "input_json_delta", partial_json: '"nas"}' },
        },
        { type: "content_block_stop", index: 1 },
      ]);
      await got.promise;
      send([
        {
          type: "message_delta",
          delta: { stop_reason: "tool_use", stop_sequence: null },
          usage: { output_tokens: 20 },
        },
        { type: "message_stop" },
      ]);
      c.close();
    },
  });
  const client = new AnthropicModelClient("sk-test");
  (client as unknown as { client: Anthropic }).client = new Anthropic({
    apiKey: "sk-test",
    fetch: async () => new Response(body, { headers: { "content-type": "text/event-stream" } }),
  });
  const blocks: unknown[] = [];
  const res = await client.stream(
    { model: "claude-haiku-5-5", max_tokens: 100, messages: [{ role: "user", content: "hi" }] },
    {
      onFailedUsage: () => {},
      onBlock: (b) => {
        blocks.push(structuredClone(b));
        if (b.type === "tool_use") got.resolve();
      },
    },
  );
  expect(blocks).toMatchObject([
    { type: "text", text: "Checking." },
    { type: "tool_use", id: "toolu_1", name: "lab_df", input: { host: "nas" } },
  ]);
  expect(res.stop_reason).toBe("tool_use");
});

test("writes run at once on different targets; one on several waits for each", async () => {
  const log: string[] = [];
  const calls = [
    { id: "a", on: ["nas", "web"] },
    { id: "b", on: ["mc"] },
    { id: "c", on: ["web"] },
  ];
  await inBatches(
    calls,
    (c) => c.on,
    async (c) => {
      log.push(`+${c.id}`);
      await Promise.resolve();
      log.push(`-${c.id}`);
    },
  );
  expect(log).toEqual(["+a", "+b", "-a", "-b", "+c", "-c"]);
});
