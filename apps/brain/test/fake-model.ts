import type Anthropic from "@anthropic-ai/sdk";
import type { CreateParams, StreamHandlers, StreamParams } from "@hatbot/plugin-sdk";
import type { ModelClient } from "../src/agent/model";
import { REVIEW_PROMPT } from "../src/agent/prompt";

type Block = Anthropic.Beta.BetaContentBlock;
export type Scripted = {
  content: Block[];
  stop_reason?: Anthropic.Beta.BetaStopReason;
  model?: string;
  /** The response waits for this, as a slow model would. */
  wait?: Promise<unknown>;
  /** Waited for once its blocks have streamed: the end of a message still coming. */
  rest?: Promise<unknown>;
  usage?: Partial<Anthropic.Beta.BetaUsage>;
  /** Streamed first, then dropped: the stream failed there and was tried again. */
  failedWith?: string;
  failedUsage?: Partial<Anthropic.Beta.BetaUsage>;
  container?: string;
  context_management?: Anthropic.Beta.BetaContextManagementResponse;
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

/** Whether a request is a change's safety review. */
export const isReview = (p: { system?: unknown }) =>
  Array.isArray(p.system) && p.system[0]?.text === REVIEW_PROMPT;

export const text = (t: string): Block => ({ type: "text", text: t, citations: null }) as Block;
export const toolUse = (
  name: string,
  input: unknown,
  id = `toolu_${Math.random().toString(36).slice(2)}`,
): Block => ({ type: "tool_use", id, name, input }) as Block;
export const computer = (name: string, input: unknown = {}): Block =>
  ({ ...toolUse(name, input), toolset_name: "computer" }) as Block;

export const browser = (name: string, input: unknown = {}): Block =>
  ({ ...toolUse(name, input), toolset_name: "browser" }) as Block;

/** Replays scripted responses in order and records every request. */
export class FakeModel implements ModelClient {
  requests: Omit<StreamParams, "stream">[] = [];
  creates: CreateParams[] = [];
  /** Picks a response for a request before the script does: for requests made at once. */
  route: ((p: Omit<StreamParams, "stream">) => Scripted | undefined) | null = null;
  /** Gives each request a cache entry of what it sent, as a real one does: a miss writes, a hit reads. */
  caching = false;
  /** Each request's breakpoints, by system prompt and tools, and where each one's entry ends. */
  private cached = new Map<string, { at: number[]; ends: number[] }>();
  /** Replies to create() calls other than summaries, e.g. reviews. */
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
      if (next.failedUsage) h.onFailedUsage?.(params.model, usage(next.failedUsage));
      h.onRetry?.();
    }
    if (next.wait) await next.wait;
    if (h.signal?.aborted) throw h.signal.reason;
    for (const b of next.content) {
      if (b.type === "text") h.onText?.(b.text);
      if (b.type === "server_tool_use") h.onServerTool?.(b.name, b.input);
      h.onBlock?.(b);
    }
    if (next.rest) await next.rest;
    const stop =
      next.stop_reason ??
      (next.content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn");
    const res = message(
      next.model ?? params.model,
      next.content,
      stop,
      this.caching ? this.cacheUsage(params, stop !== "max_tokens") : next.usage,
    );
    if (next.context_management) res.context_management = next.context_management;
    if (next.container)
      res.container = { id: next.container, expires_at: "2026-10-17T00:00:00Z", skills: null };
    return res;
  }

  /**
   * What this request costs in the cache, as the API reads one: the entry it reads is the one a
   * request with the same system prompt and tools left before it, at a breakpoint its own
   * breakpoints reach, and it writes the rest of what it sends. `kept`: the request ended there, so
   * its own end is the entry behind its breakpoints.
   */
  private cacheUsage(params: Omit<StreamParams, "stream">, kept: boolean) {
    const key = JSON.stringify([params.system, params.tools]);
    const sent = JSON.stringify(params.messages);
    const tokens = Math.ceil(sent.length / 3.5);
    const at = [...sent.matchAll(/"cache_control":\{"type":"ephemeral"(,"ttl":"1h")?\}/g)].map(
      (m) => m.index ?? 0,
    );
    const last = this.cached.get(key);
    const ends = at.map((_, k) => {
      const before = last?.ends[k] ?? 0;
      return before && before >= (last?.at[k] ?? 0) && before <= tokens ? before : 0;
    });
    const read = ends.length ? Math.min(...ends.filter((e) => e > 0)) : 0;
    const read0 = read > 0 && read <= tokens ? read : 0;
    if (kept || at.length) this.cached.set(key, { at, ends: [...(kept ? [tokens] : []), ...ends] });
    return { cache_read_input_tokens: read0, cache_creation_input_tokens: tokens - read0 };
  }

  async create(params: CreateParams) {
    this.creates.push(structuredClone(params));
    const reply = this.onCreate?.(params) ?? this.summaries.shift() ?? "summary";
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
