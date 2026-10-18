import Anthropic from "@anthropic-ai/sdk";
import { estimateTokens, fixedTokens, requestCeiling, type Spend } from "../spend";

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
  /** The stream failed partway and is tried again: what it streamed so far is void. */
  onRetry?: () => void;
  /**
   * What an attempt that failed after it started had used, for the ledger: it may still be billed.
   * Required, so no caller leaves it out of the ledger.
   */
  onFailedUsage: (model: string, usage: Anthropic.Beta.BetaUsage) => void;
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

  /** A key set in Settings: calls from now on use it, ones under way finish on the old one. */
  setApiKey(apiKey: string) {
    this.client = new Anthropic(apiKey ? { apiKey } : {});
  }

  stream(params: Omit<StreamParams, "stream">, handlers: StreamHandlers) {
    return withRetries(() => this.streamOnce(params, handlers), handlers);
  }

  private async streamOnce(params: Omit<StreamParams, "stream">, handlers: StreamHandlers) {
    // Only withRetries tries again, so a failure isn't tried three times inside each of its tries.
    const stream = this.client.beta.messages.stream(params, {
      signal: handlers.signal,
      maxRetries: 0,
    });
    /** Server tool calls by block index, with their input so far. */
    const server = new Map<number, { name: string; json: string }>();
    /** What the attempt has used so far, once it has started. */
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

/**
 * One request that isn't streamed, its text. What it may cost is held against the limits until it's
 * recorded (PLAN.md §6.3): past one, it throws BudgetError and isn't sent. `reserve`: it may use
 * what's kept for alerts. `task`: its own limit counts too. A reply that didn't end its turn throws.
 */
export async function oneShot(
  d: { model: ModelClient; spend: Spend },
  params: CreateParams,
  ledger: { purpose: string; episodeId?: number; taskId?: number; botId?: string },
  { reserve = false, task }: { reserve?: boolean; task?: { id: number; limitUsd: number } } = {},
): Promise<string> {
  const release = d.spend.hold(
    requestCeiling(params.model, {
      prompt: fixedTokens(params.system, null) + estimateTokens(params.messages),
      maxTokens: params.max_tokens,
    }),
    task,
    { reserve },
  );
  try {
    const res = await d.model.create(params);
    d.spend.recordResponse({ model: params.model, usage: res.usage, ...ledger });
    if (res.stop_reason !== "end_turn") throw new Error(`it stopped at ${res.stop_reason}`);
    return res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  } finally {
    release();
  }
}

/** Waits before each try after the first, or longer when the API's retry-after asks. Tests shorten them. */
export const retryDelays = { ms: [1000, 4000] };
/** A retry-after longer than this isn't waited out: the request fails now. */
const MAX_RETRY_AFTER_MS = 60_000;
const RETRYABLE_TYPES = ["overloaded_error", "api_error", "timeout_error"];
const NETWORK_CODES = ["ECONNRESET", "ETIMEDOUT", "EPIPE", "ECONNREFUSED", "UND_ERR_SOCKET"];

/**
 * Whether trying the same request again may work: the API overloaded, rate-limited or failing, or the
 * connection dropped, before the stream started or partway through it.
 */
export function retryable(err: unknown): boolean {
  if (err instanceof Anthropic.APIUserAbortError) return false;
  if (err instanceof Anthropic.APIConnectionError) return true;
  if (err instanceof Anthropic.APIError)
    return (
      RETRYABLE_TYPES.includes(err.type ?? "") ||
      (err.status !== undefined && (err.status >= 500 || err.status === 429))
    );
  const e = err as { code?: string; message?: string; name?: string } | null;
  if (e?.name === "AbortError") return false;
  return (
    NETWORK_CODES.includes(e?.code ?? "") ||
    (e?.name === "TypeError" && /terminated|fetch failed|socket/i.test(e.message ?? ""))
  );
}

/** A response that stopped at a length limit: its text, and its last tool call's input, may be cut short. */
export const cutOff = (res: Pick<Anthropic.Beta.BetaMessage, "stop_reason">) =>
  res.stop_reason === "max_tokens" || res.stop_reason === "model_context_window_exceeded";

/**
 * A response that fell back to another model partway, as it's kept and acted on. Before the last
 * fallback block only text, and server tool calls with their results, stay: the declined model's
 * thinking and tool calls are dropped, as the API asks, so none of its calls run.
 */
export function afterFallback(
  content: Anthropic.Beta.BetaContentBlock[],
): Anthropic.Beta.BetaContentBlock[] {
  const at = content.findLastIndex((b) => b.type === "fallback");
  if (at <= 0) return content;
  const before = content.slice(0, at);
  const answered = new Set(before.flatMap((b) => ("tool_use_id" in b ? [b.tool_use_id] : [])));
  const paired = new Set(
    before.flatMap((b) => (b.type === "server_tool_use" && answered.has(b.id) ? [b.id] : [])),
  );
  const kept = before.filter(
    (b) =>
      b.type === "text" ||
      b.type === "fallback" ||
      (b.type === "server_tool_use" && paired.has(b.id)) ||
      ("tool_use_id" in b && paired.has(b.tool_use_id)),
  );
  return [...kept, ...content.slice(at)];
}

/** How long the API asked to wait before trying again (retry-after-ms or retry-after), or null. */
export function retryAfterMs(err: unknown, now = Date.now()): number | null {
  const headers = err instanceof Anthropic.APIError ? err.headers : undefined;
  const ms = Number.parseFloat(headers?.get("retry-after-ms") ?? "");
  if (ms > 0) return ms;
  const after = headers?.get("retry-after");
  if (!after) return null;
  const seconds = Number.parseFloat(after);
  const wait = Number.isNaN(seconds) ? Date.parse(after) - now : seconds * 1000;
  return wait > 0 ? wait : null;
}

/**
 * Runs a streamed request, trying it again up to twice when it fails (the SDK doesn't retry streams
 * itself), after the API's retry-after when it gives one. `onRetry` tells the caller to drop what that
 * attempt streamed. Tests pass their own `wait`.
 */
export async function withRetries<T>(
  attempt: () => Promise<T>,
  handlers: Pick<StreamHandlers, "onRetry" | "signal">,
  delays = retryDelays.ms,
  wait = sleep,
): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await attempt();
    } catch (err) {
      const delay = delays[i];
      if (delay === undefined || handlers.signal?.aborted || !retryable(err)) throw err;
      const asked = retryAfterMs(err);
      if (asked !== null && asked > MAX_RETRY_AFTER_MS) throw err;
      const ms = Math.max(delay, asked ?? 0);
      console.warn(`model stream failed (${modelErrorText(err)}); trying again in ${ms} ms`);
      handlers.onRetry?.();
      await wait(ms, handlers.signal);
    }
  }
}

/** Waits `ms`, or throws as soon as `signal` aborts. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function parseInput(json: string): Record<string, unknown> {
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return {};
  }
}
