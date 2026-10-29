// A model provider speaks the Messages API's shape, which Hatbot keeps its conversations in: one for
// another API translates both ways.
import type Anthropic from "@anthropic-ai/sdk";

export type StreamParams = Anthropic.Beta.Messages.MessageCreateParamsStreaming;
export type CreateParams = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
export type ModelMessage = Anthropic.Beta.BetaMessage;
export type ModelUsage = Anthropic.Beta.BetaUsage;
export type ModelMessageParam = CreateParams["messages"][number];
export type ModelTool = NonNullable<CreateParams["tools"]>[number];

export type StreamHandlers = {
  onText?: (delta: string) => void;
  onThinking?: (delta: string) => void;
  onServerTool?: (name: string, input: Record<string, unknown>) => void;
  onRetry?: () => void;
  /** A failed attempt may still be billed. Required, so no caller leaves it out of the ledger. */
  onFailedUsage: (model: string, usage: ModelUsage) => void;
  signal?: AbortSignal;
};

/** USD per million tokens. `longPrompt`: above that many prompt tokens the whole request costs more. */
export type ModelPrice = {
  input: number;
  output: number;
  cacheRead: number;
  longPrompt?: { above: number; input: number; output: number; cacheRead: number };
};

/** What a model can do besides text and tools; Hatbot leaves out what needs the rest. */
export type ModelCapabilities = {
  /** The desktop needs it. */
  computerUse?: boolean;
  webSearch?: boolean;
  webFetch?: boolean;
  images?: boolean;
  pdfs?: boolean;
  /** Notes between tools as it works, shown while a reply or task runs. */
  progressNotes?: boolean;
};

export type ModelInfo = {
  id: string;
  name: string;
  /** Unknown, it's billed at the highest rates Hatbot knows. */
  price?: ModelPrice;
  capabilities: ModelCapabilities;
  /** What may answer instead when it declines, each with its own price. */
  fallbacks?: ModelInfo[];
};

/** Given by a plugin as `models`. Its ids are its own: no two providers may share one. */
export interface ModelProvider {
  /** Its catalogue as it is now. */
  models(): ModelInfo[];
  stream(params: Omit<StreamParams, "stream">, handlers: StreamHandlers): Promise<ModelMessage>;
  create(params: CreateParams): Promise<ModelMessage>;
}

/** What a provider throws for an answer the API gave: its message is shown as it is. */
export class ModelError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/** The roles a model plays; Settings picks one for each. */
export const MODEL_ROLES = ["chat", "task", "desktop", "small", "expert"] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];

export const retryDelays = { ms: [1000, 4000] };
const MAX_RETRY_AFTER_MS = 60_000;

/** Tries again on what the provider says is passing, as long as it says to wait no more than a minute. */
export async function withRetries<T>(
  attempt: () => Promise<T>,
  handlers: Pick<StreamHandlers, "onRetry" | "signal">,
  rules: { retryable: (err: unknown) => boolean; retryAfterMs?: (err: unknown) => number | null },
  delays = retryDelays.ms,
  wait = sleep,
): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await attempt();
    } catch (err) {
      const delay = delays[i];
      if (delay === undefined || handlers.signal?.aborted || !rules.retryable(err)) throw err;
      const asked = rules.retryAfterMs?.(err) ?? null;
      if (asked !== null && asked > MAX_RETRY_AFTER_MS) throw err;
      const ms = Math.max(delay, asked ?? 0);
      console.warn(`model request failed (${errorText(err)}); trying again in ${ms} ms`);
      handlers.onRetry?.();
      await wait(ms, handlers.signal);
    }
  }
}

/** The network failing on the way, which is worth another try with any API. */
export function networkFailure(err: unknown): boolean {
  const e = err as { code?: string; message?: string; name?: string } | null;
  if (e?.name === "AbortError") return false;
  return (
    ["ECONNRESET", "ETIMEDOUT", "EPIPE", "ECONNREFUSED", "UND_ERR_SOCKET"].includes(
      e?.code ?? "",
    ) ||
    (e?.name === "TypeError" && /terminated|fetch failed|socket/i.test(e.message ?? ""))
  );
}

/** Retry-After as milliseconds, or null. */
export function retryAfterHeader(headers: Headers | undefined, now = Date.now()): number | null {
  const ms = Number.parseFloat(headers?.get("retry-after-ms") ?? "");
  if (ms > 0) return ms;
  const after = headers?.get("retry-after");
  if (!after) return null;
  const seconds = Number.parseFloat(after);
  const wait = Number.isNaN(seconds) ? Date.parse(after) - now : seconds * 1000;
  return wait > 0 ? wait : null;
}

const errorText = (err: unknown) =>
  err instanceof Error ? err.message.slice(0, 300) : "unknown error";

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
