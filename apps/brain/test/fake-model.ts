import type Anthropic from "@anthropic-ai/sdk";
import type { CreateParams, ModelClient, StreamHandlers, StreamParams } from "../src/agent/model";

type Block = Anthropic.Beta.BetaContentBlock;
export type Scripted = {
  content: Block[];
  stop_reason?: Anthropic.Beta.BetaStopReason;
  model?: string;
};

const usage = (over: Partial<Anthropic.Beta.BetaUsage> = {}) =>
  ({
    input_tokens: 1000,
    output_tokens: 200,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation: null,
    iterations: null,
    ...over,
  }) as Anthropic.Beta.BetaUsage;

export const text = (t: string): Block => ({ type: "text", text: t, citations: null }) as Block;
export const toolUse = (
  name: string,
  input: unknown,
  id = `toolu_${Math.random().toString(36).slice(2)}`,
): Block => ({ type: "tool_use", id, name, input }) as Block;

/** Replays scripted responses in order and records every request. */
export class FakeModel implements ModelClient {
  requests: Omit<StreamParams, "stream">[] = [];
  creates: CreateParams[] = [];
  constructor(
    public script: Scripted[] = [],
    public summaries: string[] = [],
  ) {}

  async stream(params: Omit<StreamParams, "stream">, h: StreamHandlers) {
    this.requests.push(structuredClone(params));
    const next = this.script.shift();
    if (!next) throw new Error("FakeModel: no scripted response left");
    for (const b of next.content) if (b.type === "text") h.onText?.(b.text);
    const stop =
      next.stop_reason ??
      (next.content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn");
    return message(next.model ?? params.model, next.content, stop);
  }

  async create(params: CreateParams) {
    this.creates.push(structuredClone(params));
    return message(params.model, [text(this.summaries.shift() ?? "summary")], "end_turn");
  }
}

function message(
  model: string,
  content: Block[],
  stop: Anthropic.Beta.BetaStopReason,
): Anthropic.Beta.BetaMessage {
  return {
    id: "msg_fake",
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: usage(),
  } as unknown as Anthropic.Beta.BetaMessage;
}
