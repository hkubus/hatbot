import { expect, test } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import { costOf } from "../src/spend";
import { FakeModel, text, toolUse } from "./fake-model";
import { testApp } from "./helpers";

type Block = Anthropic.Beta.BetaContentBlock;
const search = (query: string): Block[] => [
  { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query } } as Block,
  {
    type: "web_search_tool_result",
    tool_use_id: "srvtoolu_1",
    content: [{ type: "web_search_result", url: "https://example.com", title: "Example" }],
  } as unknown as Block,
];
const toolNames = (req: { tools?: unknown[] } | undefined) =>
  (req?.tools ?? []).map((t) => (t as { name: string }).name);

test("the chat searches the web; what it read taints the conversation", async () => {
  const chat = new FakeModel([
    { content: [...search("proxmox 9.2 release date"), text("It came out last week.")] },
  ]);
  const t = await testApp(chat);
  await t.thread.post("when did proxmox 9.2 come out?").done;

  expect(toolNames(chat.requests[0])).toEqual(expect.arrayContaining(["web_search", "web_fetch"]));
  const lines = t.events
    .filter((e) => e.type === "message.progress")
    .map((e) => (e as { text: string }).text.trim());
  expect(lines).toContain("Searching the web: proxmox 9.2 release date");
  const episode = t.db
    .query<{ tainted: number; tainted_by: string }, []>("SELECT tainted, tainted_by FROM episodes")
    .get();
  expect(episode).toEqual({
    tainted: 1,
    tainted_by: 'Searched the web for "proxmox 9.2 release date"',
  });
  expect(t.thread.list().at(-1)?.text).toBe("It came out last week.");
});

test("each web search is billed at a cent on top of tokens", async () => {
  const t = await testApp();
  const usage = {
    input_tokens: 1000,
    output_tokens: 200,
    server_tool_use: { web_search_requests: 2 },
  };
  const cost = t.spend.recordResponse({ model: "claude-haiku-5-5", purpose: "thread", usage });
  const tokens = { input: 1000, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 200 };
  expect(cost).toBeCloseTo(costOf("claude-haiku-5-5", tokens) + 0.02, 9);
});

test("a task's web reads show on its timeline and taint it", async () => {
  const chat = new FakeModel([
    { content: [toolUse("run_task", { title: "Check release", goal: "Find the release date" })] },
    { content: [text("On it.")] },
    { content: [text("Done.")] },
  ]);
  const work = new FakeModel([
    { content: search("proxmox 9.2"), stop_reason: "pause_turn" },
    {
      content: [toolUse("finish_task", { outcome: "done", summary: "Last week.", notify: false })],
    },
  ]);
  const t = await testApp(chat, work);
  t.thread.post("check the proxmox release");
  await t.thread.idle();
  await t.tasks.idle();
  const [task] = t.tasks.list();
  expect(task?.summary).toBe("Last week.");
  expect(task?.tainted).toBe(true);
  expect(t.tasks.steps(task?.id as number).map((s) => s.detail)).toContain(
    'Searched the web for "proxmox 9.2"',
  );
  expect(toolNames(work.requests[0])).toContain("web_search");
});
