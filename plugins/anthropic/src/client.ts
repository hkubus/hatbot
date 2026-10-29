import Anthropic from "@anthropic-ai/sdk";
import {
  type CreateParams,
  type ModelInfo,
  type ModelProvider,
  networkFailure,
  retryAfterHeader,
  type StreamHandlers,
  type StreamParams,
  withRetries,
} from "@hatbot/plugin-sdk";
import { MODELS } from "./catalogue";

const RETRYABLE_TYPES = ["overloaded_error", "api_error", "timeout_error"];

export function retryable(err: unknown): boolean {
  if (err instanceof Anthropic.APIUserAbortError) return false;
  if (err instanceof Anthropic.APIConnectionError) return true;
  if (err instanceof Anthropic.APIError)
    return (
      RETRYABLE_TYPES.includes(err.type ?? "") ||
      (err.status !== undefined && (err.status >= 500 || err.status === 429))
    );
  return networkFailure(err);
}

export const retryAfterMs = (err: unknown, now = Date.now()) =>
  retryAfterHeader(err instanceof Anthropic.APIError ? err.headers : undefined, now);

const rules = { retryable, retryAfterMs };

/** The cheapest call that needs a working key. */
export async function checkKey(key: string) {
  await new Anthropic({ apiKey: key, maxRetries: 0, timeout: 15_000 }).models.list({ limit: 1 });
}

export class AnthropicModelClient implements ModelProvider {
  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  models(): ModelInfo[] {
    return MODELS;
  }

  stream(params: Omit<StreamParams, "stream">, handlers: StreamHandlers) {
    return withRetries(() => this.streamOnce(params, handlers), handlers, rules);
  }

  private async streamOnce(params: Omit<StreamParams, "stream">, handlers: StreamHandlers) {
    // Only withRetries tries again, so a failure isn't tried three times inside each of its tries.
    const stream = this.client.beta.messages.stream(params, {
      signal: handlers.signal,
      maxRetries: 0,
    });
    const server = new Map<number, { name: string; json: string }>();
    let used: { model: string; usage: Anthropic.Beta.BetaUsage } | null = null;
    try {
      for await (const event of stream) {
        if (event.type === "message_start")
          used = { model: event.message.model, usage: { ...event.message.usage } };
        if (event.type === "message_delta" && used)
          for (const [k, v] of Object.entries(event.usage))
            if (v !== null) (used.usage as unknown as Record<string, unknown>)[k] = v;
        if (event.type === "content_block_start") {
          // Each thinking block starts on a line of its own, so the last line is the latest thought.
          if (event.content_block.type === "thinking") handlers.onThinking?.("\n");
          if (event.content_block.type === "server_tool_use")
            server.set(event.index, { name: event.content_block.name, json: "" });
        }
        if (event.type === "content_block_stop") {
          const call = server.get(event.index);
          if (call) handlers.onServerTool?.(call.name, parseInput(call.json));
        }
        if (event.type !== "content_block_delta") continue;
        if (event.delta.type === "text_delta") handlers.onText?.(event.delta.text);
        else if (event.delta.type === "thinking_delta") handlers.onThinking?.(event.delta.thinking);
        else if (event.delta.type === "input_json_delta") {
          const call = server.get(event.index);
          if (call) call.json += event.delta.partial_json;
        }
      }
      return await stream.finalMessage();
    } catch (err) {
      if (used) handlers.onFailedUsage(used.model, used.usage);
      throw err;
    }
  }

  create(params: CreateParams) {
    return this.client.beta.messages.create(params);
  }
}

function parseInput(json: string): Record<string, unknown> {
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return {};
  }
}
