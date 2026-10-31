// The tokens one chat turn and one background task send to the model, as the brain builds them.
// Nothing is billed: FakeModel records each request it was given.
//
//   bun benchmarks/prompt-cost.ts
//
// Turn 1 of a chat sends the whole system prompt and every tool; the turn after a tool result
// re-sends them plus the conversation. A task sends its own system prompt and tools.
import { FakeModel, text } from "../apps/brain/test/fake-model";
import { testApp } from "../apps/brain/test/helpers";

/** Roughly Claude's tokenizer for English and JSON: about four characters a token. */
export const estimateTokens = (v: unknown) => Math.ceil(JSON.stringify(v ?? "").length / 4);

const chars = (v: unknown) => JSON.stringify(v ?? "").length;

type Parts = {
  system: number;
  tools: number;
  toolsJson: number;
  messages: number;
  toolNames: number;
};
const partsOf = (r: { system?: unknown; tools?: unknown; messages?: unknown }): Parts => ({
  system: chars(r.system),
  tools: chars(r.tools),
  toolsJson: 0,
  messages: chars(r.messages),
  toolNames: (r.tools ?? []).length,
});

const show = (label: string, p: Parts) => {
  const total = p.system + p.tools + p.messages;
  console.log(
    `${label.padEnd(34)} ${String(Math.ceil(total / 4)).padStart(7)} tok  ` +
      `system ${String(Math.ceil(p.system / 4)).padStart(6)}  tools ${String(
        Math.ceil(p.tools / 4),
      ).padStart(6)} (${String(p.toolNames).padStart(3)})  messages ${String(
        Math.ceil(p.messages / 4),
      ).padStart(6)}`,
  );
  return Math.ceil(total / 4);
};

const model = new FakeModel([
  { content: [{ type: "text", text: "Hello there.", citations: null } as never] },
]);
const t = await testApp(model);
await t.thread.post("hi").done;
const first = model.requests[0];
show("chat: first turn", partsOf(first));

const toolModel = new FakeModel([
  {
    content: [
      {
        type: "tool_use",
        id: "toolu_1",
        name: "search_history",
        input: { query: "zebras" },
      } as never,
    ],
  },
  { content: [text("Found it.")] },
]);
const t2 = await testApp(toolModel);
await t2.thread.post("what did we say about zebras").done;
show("chat: turn with a tool result", partsOf(toolModel.requests[1]));

const taskChat = new FakeModel([
  {
    content: [
      {
        type: "tool_use",
        id: "toolu_2",
        name: "run_task",
        input: { title: "Look", goal: "Look at the NAS" },
      } as never,
    ],
  },
  { content: [text("Started it.")] },
]);
const taskWork = new FakeModel([
  {
    content: [
      {
        type: "tool_use",
        id: "toolu_3",
        name: "finish_task",
        input: { outcome: "done", summary: "The NAS is fine.", notify: false },
      } as never,
    ],
  },
]);
const t3 = await testApp(taskChat, taskWork);
await t3.thread.post("check the nas").done;
await t3.tasks.idle();
show("task: first turn", partsOf(taskWork.requests[0]));

// A bot with no desktop and no boxes can't use their tools: they aren't sent, nor sent to its search.
const bare = new FakeModel([{ content: [text("Hi.")] }]);
const t4 = await testApp(bare);
t4.agent.configured = false;
t4.hatbox.configured = false;
await t4.thread.post("hi").done;
show("chat: no desktop, no boxes", partsOf(bare.requests[0]));

const research = process.argv.includes("--research");
if (research) {
  const r = await import("../apps/brain/src/agent/prompt");
  const { RESEARCH_PROMPT } = r as Record<string, string>;
  console.log("research prompt chars", RESEARCH_PROMPT?.length);
}

const quota = process.argv.includes("--json");
if (quota) {
  console.log(
    JSON.stringify({
      chatFirst: estimateTokens(first),
      chatTool: estimateTokens(toolModel.requests[1]),
    }),
  );
}
process.exit(0);
