import Anthropic from "@anthropic-ai/sdk";

/** A model failure in a line, for the owner: the API's own message when there is one. */
export function modelErrorText(err: unknown): string {
  if (err instanceof Anthropic.APIError) {
    const detail = (err.error as { error?: { message?: string } } | undefined)?.error?.message;
    return `the API said ${err.status ?? "nothing"}${detail ? `: ${detail.slice(0, 300)}` : ""}`;
  }
  return err instanceof Error ? err.message.slice(0, 300) : "unknown error";
}

export type StreamParams = Anthropic.Beta.Messages.MessageCreateParamsStreaming;
export type CreateParams = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
export type StreamHandlers = {
  onText?: (delta: string) => void;
  onThinking?: (delta: string) => void;
  /** A tool the API runs itself, like web search, once its input is complete. */
  onServerTool?: (name: string, input: Record<string, unknown>) => void;
  signal?: AbortSignal;
};

/** The slice of the SDK the brain uses; tests substitute a scripted fake. */
export interface ModelClient {
  stream(
    params: Omit<StreamParams, "stream">,
    handlers: StreamHandlers,
  ): Promise<Anthropic.Beta.BetaMessage>;
  create(params: CreateParams): Promise<Anthropic.Beta.BetaMessage>;
}

export class AnthropicModelClient implements ModelClient {
  private client: Anthropic;

  constructor(apiKey?: string) {
    this.client = new Anthropic(apiKey ? { apiKey } : {});
  }

  async stream(params: Omit<StreamParams, "stream">, handlers: StreamHandlers) {
    const stream = this.client.beta.messages.stream(params, { signal: handlers.signal });
    /** Server tool calls by block index, with their input so far. */
    const server = new Map<number, { name: string; json: string }>();
    for await (const event of stream) {
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
    return stream.finalMessage();
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
