// Hatbot's requests are in the Messages API's shape; this speaks OpenAI's chat completions for them,
// both ways. What has no counterpart there (thinking blocks, server tools, cache marks) is left out.
import type {
  CreateParams,
  ModelMessage,
  ModelMessageParam,
  ModelTool,
  ModelUsage,
} from "@hatbot/plugin-sdk";

type Params = Omit<CreateParams, "stream">;
type Block = Exclude<ModelMessageParam["content"], string>[number];

type Part =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: "file"; file: { filename: string; file_data: string } };
type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: Part[] }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export type ChatRequest = {
  model: string;
  max_tokens?: number;
  max_completion_tokens?: number;
  messages: ChatMessage[];
  tools?: {
    type: "function";
    function: { name: string; description?: string; parameters: unknown };
  }[];
  tool_choice?: "auto" | "required" | "none" | { type: "function"; function: { name: string } };
  temperature?: number;
  reasoning?: { effort: Effort };
  reasoning_effort?: Effort;
  response_format?: { type: "json_schema"; json_schema: { name: string; schema: unknown } };
  stream?: boolean;
  stream_options?: { include_usage: boolean };
};

export type ChatUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  prompt_tokens_details?: { cached_tokens?: number } | null;
};

export type ChatResponse = {
  id?: string;
  choices: {
    message: { content?: string | null; tool_calls?: ToolCall[] | null };
    finish_reason?: string | null;
  }[];
  usage?: ChatUsage;
};

type Effort = "low" | "medium" | "high";
const EFFORT = { low: "low", medium: "medium", high: "high", xhigh: "high", max: "high" } as const;

const textOf = (blocks: string | { type: string; text?: string }[] | undefined | null) =>
  typeof blocks === "string"
    ? blocks
    : (blocks ?? []).flatMap((b) => (b.type === "text" && b.text ? [b.text] : [])).join("\n\n");

/** What the API and the model take beyond text. */
export type Dialect = { openRouter: boolean; images: boolean; pdfs: boolean; reasoning: boolean };

function part(b: Block, d: Dialect): Part | null {
  if (b.type === "text") return { type: "text", text: b.text };
  if (b.type === "image") {
    if (!d.images) return { type: "text", text: "(An image this model can't see.)" };
    const s = b.source;
    if (s.type === "base64")
      return { type: "image_url", image_url: { url: `data:${s.media_type};base64,${s.data}` } };
    if (s.type === "url") return { type: "image_url", image_url: { url: s.url } };
    return null;
  }
  if (b.type === "document") {
    const s = b.source;
    if (s.type === "base64" && !d.pdfs)
      return { type: "text", text: "(A PDF this model can't read.)" };
    if (s.type === "base64")
      return {
        type: "file",
        file: {
          filename: b.title ?? "document.pdf",
          file_data: `data:${s.media_type};base64,${s.data}`,
        },
      };
    if (s.type === "text") return { type: "text", text: s.data };
    if (s.type === "url") return { type: "text", text: `(A document: ${s.url})` };
    return null;
  }
  return null;
}

function userMessages(content: ModelMessageParam["content"], d: Dialect): ChatMessage[] {
  if (typeof content === "string")
    return [{ role: "user", content: [{ type: "text", text: content }] }];
  const out: ChatMessage[] = [];
  const parts: Part[] = [];
  for (const b of content) {
    if (b.type === "tool_result") {
      const blocks = typeof b.content === "string" ? [] : (b.content ?? []);
      const text =
        typeof b.content === "string"
          ? b.content
          : textOf(blocks as { type: string; text?: string }[]);
      out.push({
        role: "tool",
        tool_call_id: b.tool_use_id,
        content: b.is_error ? `Error: ${text}` : text || "(no output)",
      });
      // A tool message takes only text: its images follow, in the user message after the results.
      for (const x of blocks) {
        const p = x.type === "text" ? null : part(x as Block, d);
        if (p) parts.push(p);
      }
      continue;
    }
    const p = part(b, d);
    if (p) parts.push(p);
  }
  if (parts.length) out.push({ role: "user", content: parts });
  return out;
}

function assistantMessage(content: ModelMessageParam["content"]): ChatMessage | null {
  if (typeof content === "string") return { role: "assistant", content };
  const text = textOf(content as { type: string; text?: string }[]);
  const calls: ToolCall[] = content.flatMap((b) =>
    b.type === "tool_use"
      ? [
          {
            id: b.id,
            type: "function" as const,
            function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
          },
        ]
      : [],
  );
  if (!text && !calls.length) return null;
  return {
    role: "assistant",
    content: text || null,
    ...(calls.length ? { tool_calls: calls } : {}),
  };
}

const isFunction = (t: ModelTool): t is Extract<ModelTool, { input_schema: unknown }> =>
  "input_schema" in t && (!("type" in t) || t.type === undefined || t.type === "custom");

// OpenRouter takes the older max_tokens and its own reasoning object; OpenAI's own API wants these
// instead, and only reasoning models take an effort.
export function toChat(p: Params, d: Dialect): ChatRequest {
  const messages: ChatMessage[] = [];
  const system = textOf(p.system as string | { type: string; text?: string }[] | undefined);
  if (system) messages.push({ role: "system", content: system });
  for (const m of p.messages) {
    if (m.role === "user") messages.push(...userMessages(m.content, d));
    else {
      const a = assistantMessage(m.content);
      if (a) messages.push(a);
    }
  }
  const tools = (p.tools ?? []).filter(isFunction).map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      ...(t.description ? { description: t.description } : {}),
      parameters: t.input_schema,
    },
  }));
  const choice = p.tool_choice;
  const effort =
    d.reasoning && p.thinking && p.thinking.type !== "disabled" && p.output_config?.effort
      ? EFFORT[p.output_config.effort]
      : undefined;
  const format = p.output_config?.format;
  return {
    model: p.model,
    ...(d.openRouter ? { max_tokens: p.max_tokens } : { max_completion_tokens: p.max_tokens }),
    messages,
    ...(tools.length ? { tools } : {}),
    ...(tools.length && choice
      ? {
          tool_choice:
            choice.type === "tool"
              ? { type: "function" as const, function: { name: choice.name } }
              : choice.type === "any"
                ? ("required" as const)
                : choice.type === "none"
                  ? ("none" as const)
                  : ("auto" as const),
        }
      : {}),
    ...(p.temperature !== undefined ? { temperature: p.temperature } : {}),
    ...(effort ? (d.openRouter ? { reasoning: { effort } } : { reasoning_effort: effort }) : {}),
    ...(format?.type === "json_schema"
      ? {
          response_format: {
            type: "json_schema" as const,
            json_schema: { name: "answer", schema: format.schema },
          },
        }
      : {}),
  };
}

export function usageOf(u: ChatUsage | undefined): ModelUsage {
  const cached = u?.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    input_tokens: Math.max(0, (u?.prompt_tokens ?? 0) - cached),
    output_tokens: u?.completion_tokens ?? 0,
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: 0,
  } as ModelUsage;
}

function input(json: string): unknown {
  try {
    return JSON.parse(json || "{}");
  } catch {
    return {};
  }
}

const STOP: Record<string, ModelMessage["stop_reason"]> = {
  stop: "end_turn",
  length: "max_tokens",
  tool_calls: "tool_use",
  content_filter: "refusal",
};

/** Its answer as the Messages API gives one, for `model` (the one asked: it's priced by that). */
export function fromChat(res: ChatResponse, model: string): ModelMessage {
  const choice = res.choices[0];
  const text = choice?.message.content ?? "";
  const calls = choice?.message.tool_calls ?? [];
  const content = [
    ...(text ? [{ type: "text", text, citations: null }] : []),
    ...calls.map((c) => ({
      type: "tool_use",
      id: c.id,
      name: c.function.name,
      input: input(c.function.arguments),
    })),
  ];
  const finish = STOP[choice?.finish_reason ?? "stop"];
  // Cut off at the limit, a call's input is likely cut short too: it mustn't be run.
  const stop =
    finish === "max_tokens" ? finish : calls.length ? "tool_use" : (finish ?? "end_turn");
  return {
    id: res.id ?? "",
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: usageOf(res.usage),
    container: null,
    context_management: null,
  } as unknown as ModelMessage;
}

type Delta = {
  content?: string | null;
  reasoning?: string | null;
  tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[];
};
export type ChatChunk = {
  id?: string;
  choices?: { delta?: Delta; finish_reason?: string | null }[];
  usage?: ChatUsage;
  error?: { message?: string; code?: number | string };
};

/** A streamed answer, put together chunk by chunk. */
export class ChatStream {
  private id = "";
  private text = "";
  private calls = new Map<number, ToolCall>();
  private finish: string | null = null;
  private usage: ChatUsage | undefined;

  add(chunk: ChatChunk, on: { text?: (d: string) => void; thinking?: (d: string) => void }) {
    if (chunk.id) this.id = chunk.id;
    if (chunk.usage) this.usage = chunk.usage;
    for (const c of chunk.choices ?? []) {
      const d = c.delta ?? {};
      if (d.content) {
        this.text += d.content;
        on.text?.(d.content);
      }
      if (d.reasoning) on.thinking?.(d.reasoning);
      for (const t of d.tool_calls ?? []) {
        const call = this.calls.get(t.index) ?? {
          id: `call_${crypto.randomUUID()}`,
          type: "function",
          function: { name: "", arguments: "" },
        };
        if (t.id) call.id = t.id;
        if (t.function?.name) call.function.name += t.function.name;
        if (t.function?.arguments) call.function.arguments += t.function.arguments;
        this.calls.set(t.index, call);
      }
      if (c.finish_reason) this.finish = c.finish_reason;
    }
  }

  /** Whether it got to its end; an API may close the stream before then, or end it with "error". */
  get finished() {
    return this.finish !== null && this.finish !== "error";
  }

  message(model: string): ModelMessage {
    return fromChat(
      {
        id: this.id,
        choices: [
          {
            message: { content: this.text, tool_calls: [...this.calls.values()] },
            finish_reason: this.finish,
          },
        ],
        usage: this.usage,
      },
      model,
    );
  }
}
