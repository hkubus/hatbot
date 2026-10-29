import {
  type CreateParams,
  ModelError,
  type ModelInfo,
  type ModelMessage,
  type ModelProvider,
  networkFailure,
  retryAfterHeader,
  type StreamHandlers,
  type StreamParams,
  withRetries,
} from "@hatbot/plugin-sdk";
import {
  type ChatChunk,
  type ChatResponse,
  ChatStream,
  type Dialect,
  fromChat,
  toChat,
} from "./translate";

export const OPENROUTER = "https://openrouter.ai/api/v1";

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** The API's answer to a request it refused, with what it said. */
class ApiError extends ModelError {
  constructor(
    message: string,
    status: number,
    readonly headers?: Headers,
  ) {
    super(message, status);
  }
}

async function apiError(res: Response): Promise<ApiError> {
  const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
  const detail = body?.error?.message;
  return new ApiError(
    `the API said ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`,
    res.status,
    res.headers,
  );
}

/** A stream that ended before its answer did. */
class CutOff extends ModelError {}

export function retryable(err: unknown): boolean {
  if (err instanceof CutOff) return true;
  if (err instanceof ModelError && err.status !== undefined)
    return err.status >= 500 || err.status === 429 || err.status === 408;
  return networkFailure(err);
}

const rules = {
  retryable,
  retryAfterMs: (err: unknown) =>
    retryAfterHeader(err instanceof ApiError ? err.headers : undefined),
};

/** Server-sent events' data, until [DONE]. */
async function* events(body: ReadableStream<Uint8Array>): AsyncGenerator<ChatChunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
      const line = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      // Comments (": OPENROUTER PROCESSING") keep the connection open.
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") return;
      yield JSON.parse(data) as ChatChunk;
    }
  }
}

/** A model as listed, and whether it takes a reasoning effort. */
export type Listing = ModelInfo & { reasoning: boolean };

const openRouter = (baseUrl: string) => new URL(baseUrl).host === "openrouter.ai";

export class OpenAIModelClient implements ModelProvider {
  constructor(
    private o: {
      baseUrl: string;
      key: string;
      models: Listing[];
      fetch: Fetch;
    },
  ) {}

  models(): ModelInfo[] {
    return this.o.models;
  }

  stream(params: Omit<StreamParams, "stream">, handlers: StreamHandlers): Promise<ModelMessage> {
    return withRetries(() => this.streamOnce(params, handlers), handlers, rules);
  }

  create(params: CreateParams): Promise<ModelMessage> {
    return withRetries(
      async () =>
        fromChat((await (await this.post(params, false)).json()) as ChatResponse, params.model),
      {},
      rules,
    );
  }

  private async streamOnce(params: Omit<StreamParams, "stream">, handlers: StreamHandlers) {
    const res = await this.post(params, true, handlers.signal);
    if (!res.body) throw new ModelError("the API sent no answer");
    const answer = new ChatStream();
    for await (const chunk of events(res.body)) {
      if (chunk.error) {
        const status = typeof chunk.error.code === "number" ? chunk.error.code : undefined;
        throw new ModelError(
          `the API said ${status ?? "no"}: ${chunk.error.message ?? "it failed"}`,
          status,
        );
      }
      answer.add(chunk, { text: handlers.onText, thinking: handlers.onThinking });
    }
    if (!answer.finished) throw new CutOff("the API stopped before it finished");
    return answer.message(params.model);
  }

  private dialect(model: string): Dialect {
    const m = this.o.models.find((x) => x.id === model);
    return {
      openRouter: openRouter(this.o.baseUrl),
      images: m?.capabilities.images ?? false,
      pdfs: m?.capabilities.pdfs ?? false,
      reasoning: m?.reasoning ?? false,
    };
  }

  private async post(params: Omit<CreateParams, "stream">, stream: boolean, signal?: AbortSignal) {
    const body = {
      ...toChat(params, this.dialect(params.model)),
      ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
    };
    const res = await this.o.fetch(`${this.o.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.o.key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) throw await apiError(res);
    return res;
  }
}

type Listed = {
  id: string;
  name?: string;
  pricing?: { prompt?: string; completion?: string; input_cache_read?: string };
  supported_parameters?: string[];
  architecture?: { input_modalities?: string[] };
};

/** USD a token, as a string, to USD a million. */
const perMillion = (usd: string | undefined) => {
  const n = Number(usd);
  return Number.isFinite(n) && n >= 0 ? n * 1_000_000 : null;
};

/** The models it lists: those given, or, with none given, every one that takes tools. */
export async function catalogue(
  o: { baseUrl: string; key: string; fetch: Fetch },
  only: string[],
): Promise<Listing[]> {
  const res = await o.fetch(`${o.baseUrl}/models`, {
    headers: { authorization: `Bearer ${o.key}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw await apiError(res);
  const { data } = (await res.json()) as { data?: Listed[] };
  const listed = (data ?? []).filter((m) =>
    only.length ? only.includes(m.id) : (m.supported_parameters?.includes("tools") ?? true),
  );
  return listed.map((m) => {
    const input = perMillion(m.pricing?.prompt);
    const output = perMillion(m.pricing?.completion);
    const inputs = m.architecture?.input_modalities ?? ["text"];
    return {
      id: m.id,
      name: m.name ?? m.id,
      ...(input !== null && output !== null
        ? { price: { input, output, cacheRead: perMillion(m.pricing?.input_cache_read) ?? input } }
        : {}),
      capabilities: { images: inputs.includes("image"), pdfs: inputs.includes("file") },
      reasoning: m.supported_parameters?.includes("reasoning") ?? false,
    };
  });
}
