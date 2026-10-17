import type Anthropic from "@anthropic-ai/sdk";
import type { CreateParams, ModelClient, StreamHandlers, StreamParams } from "../src/agent/model";
import { SCREENING_PROMPT } from "../src/agent/prompt";

const NOT_SUSPECTED = '{"suspected": false, "excerpt": ""}';

type Block = Anthropic.Beta.BetaContentBlock;
export type Scripted = {
  content: Block[];
  stop_reason?: Anthropic.Beta.BetaStopReason;
  model?: string;
  /** The response waits for this, as a slow model would. */
  wait?: Promise<unknown>;
  usage?: Partial<Anthropic.Beta.BetaUsage>;
  /** Streamed first, then dropped: the stream failed there and was tried again. */
  failedWith?: string;
  /** The code execution container the response ran in. */
  container?: string;
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
/** A computer toolset member call. */
export const computer = (name: string, input: unknown = {}): Block =>
  ({ ...toolUse(name, input), toolset_name: "computer" }) as Block;

/** A browser toolset member call. */
export const browser = (name: string, input: unknown = {}): Block =>
  ({ ...toolUse(name, input), toolset_name: "browser" }) as Block;

/** Replays scripted responses in order and records every request. */
export class FakeModel implements ModelClient {
  requests: Omit<StreamParams, "stream">[] = [];
  creates: CreateParams[] = [];
  /** Picks a response for a request before the script does: for requests made at once. */
  route: ((p: Omit<StreamParams, "stream">) => Scripted | undefined) | null = null;
  /** Replies to create() calls other than summaries, e.g. injection screening. */
  onCreate: ((p: CreateParams) => string | undefined) | null = null;
  constructor(
    public script: Scripted[] = [],
    public summaries: string[] = [],
  ) {}

  async stream(params: Omit<StreamParams, "stream">, h: StreamHandlers) {
    this.requests.push(structuredClone(params));
    const next = this.route?.(params) ?? this.script.shift();
    if (!next) throw new Error("FakeModel: no scripted response left");
    if (h.signal?.aborted) throw h.signal.reason;
    if (next.failedWith !== undefined) {
      h.onText?.(next.failedWith);
      h.onRetry?.();
    }
    if (next.wait) await next.wait;
    if (h.signal?.aborted) throw h.signal.reason;
    for (const b of next.content) {
      if (b.type === "text") h.onText?.(b.text);
      if (b.type === "server_tool_use") h.onServerTool?.(b.name, b.input);
    }
    const stop =
      next.stop_reason ??
      (next.content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn");
    const res = message(next.model ?? params.model, next.content, stop, next.usage);
    if (next.container)
      res.container = { id: next.container, expires_at: "2026-10-17T00:00:00Z", skills: null };
    return res;
  }

  async create(params: CreateParams) {
    this.creates.push(structuredClone(params));
    // Injection screening finds nothing unless a test says otherwise; it takes no summary's place.
    const reply =
      this.onCreate?.(params) ??
      (params.system === SCREENING_PROMPT ? NOT_SUSPECTED : undefined) ??
      this.summaries.shift() ??
      "summary";
    // A forced tool call: the reply is its input, as JSON.
    if (params.tool_choice?.type === "tool")
      return message(
        params.model,
        [toolUse(params.tool_choice.name, JSON.parse(reply))],
        "tool_use",
      );
    return message(params.model, [text(reply)], "end_turn");
  }
}

function message(
  model: string,
  content: Block[],
  stop: Anthropic.Beta.BetaStopReason,
  over?: Partial<Anthropic.Beta.BetaUsage>,
): Anthropic.Beta.BetaMessage {
  return {
    id: "msg_fake",
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: usage(over),
  } as unknown as Anthropic.Beta.BetaMessage;
}
