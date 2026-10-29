import type Anthropic from "@anthropic-ai/sdk";
import {
  type CreateParams,
  ModelError,
  type ModelMessage,
  type StreamHandlers,
  type StreamParams,
} from "@hatbot/plugin-sdk";
import { estimateTokens, fixedTokens, requestCeiling, type Spend } from "../spend";

export type { CreateParams, StreamHandlers, StreamParams };

/** An API's error object, as Anthropic's and OpenAI's SDKs give it. */
type ApiFailure = Error & { status?: number; error?: { error?: { message?: string } } };

export function modelErrorText(err: unknown): string {
  if (err instanceof ModelError) return err.message.slice(0, 300);
  const api = err as ApiFailure;
  if (err instanceof Error && typeof api.status === "number") {
    const detail = api.error?.error?.message;
    return `the API said ${api.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`;
  }
  return err instanceof Error ? err.message.slice(0, 300) : "unknown error";
}

export interface ModelClient {
  stream(params: Omit<StreamParams, "stream">, handlers: StreamHandlers): Promise<ModelMessage>;
  create(params: CreateParams): Promise<ModelMessage>;
}

/**
 * What it may cost is held against the limits until it's recorded: past one, it throws BudgetError
 * and isn't sent. `reserve`: it may use what's kept for alerts.
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

export const cutOff = (res: Pick<Anthropic.Beta.BetaMessage, "stop_reason">) =>
  res.stop_reason === "max_tokens" || res.stop_reason === "model_context_window_exceeded";

/**
 * Before the last fallback block only text, and server tool calls with their results, stay: the
 * declined model's thinking and tool calls are dropped, as the API asks, so none of its calls run.
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
