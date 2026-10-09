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
    for await (const event of stream) {
      if (event.type !== "content_block_delta") continue;
      if (event.delta.type === "text_delta") handlers.onText?.(event.delta.text);
      else if (event.delta.type === "thinking_delta") handlers.onThinking?.(event.delta.thinking);
    }
    return stream.finalMessage();
  }

  create(params: CreateParams) {
    return this.client.beta.messages.create(params);
  }
}
