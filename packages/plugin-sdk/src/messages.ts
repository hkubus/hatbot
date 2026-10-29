// Helpers for the Messages API's shape, which conversations are kept in: the web tools, what a
// response read, token estimates, and the text a tool answers with.
import type Anthropic from "@anthropic-ai/sdk";
import { HATBOT_ID } from "@hatbot/shared";
import { z } from "zod";
import { ModelError } from "./models";

/** JSON to put in a prompt: `<` can't close a tag around it. */
export const tagJson = (value: unknown): string =>
  (JSON.stringify(value) ?? "null").replace(/</g, "\\u003c");

/** A tool for the API, its input schema from zod's unless given. */
export const toolParam = (t: {
  name: string;
  description: string;
  schema: z.ZodType;
  jsonSchema?: Record<string, unknown>;
}): Anthropic.Beta.BetaTool => ({
  name: t.name,
  description: t.description,
  input_schema: (t.jsonSchema ??
    z.toJSONSchema(t.schema, { io: "input" })) as Anthropic.Beta.BetaTool.InputSchema,
  eager_input_streaming: true,
});

/** Untrusted text to screen: a PDF as it came. */
export type Readable = string | { pdf: string };

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

export const cutOff = (res: Pick<Anthropic.Beta.BetaMessage, "stop_reason">) =>
  res.stop_reason === "max_tokens" || res.stop_reason === "model_context_window_exceeded";

export class BudgetError extends Error {
  constructor(
    readonly limit: "task" | "daily" | "monthly",
    message: string,
  ) {
    super(message);
  }
}

export function estimateTokens(messages: unknown): number {
  let chars = 0;
  let images = 0;
  let pdfTokens = 0;
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (o.type === "image") {
        images++;
        return;
      }
      const source = o.source as { type?: string; data?: unknown } | undefined;
      if (o.type === "document" && source?.type === "base64") {
        // A page or two per 100 KB; about 1,500 tokens a page.
        const kb = (String(source.data ?? "").length * 0.75) / 1024;
        pdfTokens += Math.max(1500, kb * 25);
        return;
      }
      for (const [k, x] of Object.entries(o)) {
        if (typeof x !== "string") walk(x);
        else if (!(k === "data" && o.type === "base64") && k !== "signature") chars += x.length;
      }
    }
  };
  walk(messages);
  return chars / 3.5 + images * 1600 + pdfTokens;
}

export const invalidInput = (error: z.ZodError) => `Invalid input: ${z.prettifyError(error)}`;

/** Each value in `body` must be in tagJson already, so none can close the block or open another. */
export function untrustedFields(
  tag: string,
  body: string,
  attrs: Record<string, string> = {},
): string {
  const named = Object.entries(attrs)
    .map(([k, v]) => ` ${k}=${tagJson(v)}`)
    .join("");
  return `<${tag}${named} trusted="false">\n${body}\n</${tag}>`;
}

export const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function localStamp(d: Date): string {
  const day = d.toLocaleDateString("en-GB", { weekday: "short" });
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${day} ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Letters that don't decompose into a plain one and an accent. */
const FOLDED: Record<string, string> = {
  ł: "l",
  đ: "d",
  ð: "d",
  ø: "o",
  ß: "ss",
  æ: "ae",
  œ: "oe",
  þ: "th",
  ı: "i",
};

export function slugWords(text: string): string {
  return text
    .toLowerCase()
    .replace(/[łđðøßæœþı]/g, (c) => FOLDED[c] ?? c)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Hatbot's notes are the shared memory itself. */
export const botFolder = (id: string) => (id === HATBOT_ID ? null : `bots/${id}`);

export const pathOf = (path: string) => path.replace(/\/+$/, "") || "/";

export const TRACKING =
  /^(?:utm_\w*|fbclid|gclid|gbraid|wbraid|dclid|msclkid|yclid|mc_[ce]id|_ga|igshid)$/i;

// The text editor views and writes files in the same container as the code.
const CODE_TOOLS = ["code_execution", "bash_code_execution", "text_editor_code_execution"];

/**
 * The versions with dynamic filtering: a call made from code stays out of the response, with what it
 * read; the code's output is what the model sees. HATBOT_WEB_TOOLS=basic brings back the versions
 * without filtering, should the API refuse these.
 */
export function webTools(opts: {
  pageTokens: number;
  uses?: number;
  citations?: boolean;
  timeZone?: string;
  env?: Record<string, string | undefined>;
}): Anthropic.Beta.BetaToolUnion[] {
  const uses = opts.uses ?? 8;
  const zone = opts.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const where =
    zone && !/^(Etc\/)?(UTC|GMT|Universal|Zulu)$/.test(zone)
      ? { user_location: { type: "approximate" as const, timezone: zone } }
      : {};
  const cite = opts.citations ? { citations: { enabled: true } } : {};
  if ((opts.env ?? process.env).HATBOT_WEB_TOOLS === "basic")
    return [
      { type: "web_search_20250305", name: "web_search", max_uses: uses, ...where },
      {
        type: "web_fetch_20250910",
        name: "web_fetch",
        max_uses: uses,
        max_content_tokens: opts.pageTokens,
        ...cite,
      },
    ];
  const filtered = () => ({
    allowed_callers: ["direct" as const, "code_execution_20260120" as const],
    response_inclusion: "excluded" as const,
  });
  return [
    { type: "web_search_20260318", name: "web_search", max_uses: uses, ...filtered(), ...where },
    {
      type: "web_fetch_20260318",
      name: "web_fetch",
      max_uses: uses,
      max_content_tokens: opts.pageTokens,
      ...filtered(),
      ...cite,
    },
  ];
}

/** A search ("" when the code doesn't say what for) or a page read ("" when it doesn't say which). */
export type WebCall = { search: string } | { read: string };

const STRING = String.raw`[fFrRuU]?(["'])((?:\\.|(?!\1).)*)\1`;
const QUERY = new RegExp(String.raw`(?:["']query["']\s*:|\bquery\s*=)\s*${STRING}`, "g");
const URL_IN_CODE = /https?:\/\/[^\s"'`\\<>)\]}]+/g;
const MAX_CALLS = 10;

/** For code the model ran, from the queries and URLs written in it. */
export function webCalls(name: string, input: Record<string, unknown>): WebCall[] {
  if (name === "web_search") return [{ search: String(input.query ?? "") }];
  if (name === "web_fetch") return [{ read: String(input.url ?? "") }];
  if (!CODE_TOOLS.includes(name)) return [];
  const code = Object.values(input)
    .filter((v): v is string => typeof v === "string")
    .join("\n");
  const calls: WebCall[] = [];
  if (/\bweb_search\s*\(/.test(code)) {
    const queries = [...code.matchAll(QUERY)].map((m) => (m[2] ?? "").replace(/\\(.)/g, "$1"));
    const unique = [...new Set(queries.filter((q) => q.trim()))];
    calls.push(...(unique.length ? unique.map((search) => ({ search })) : [{ search: "" }]));
  }
  if (/\bweb_fetch\s*\(/.test(code)) {
    const urls = [...new Set(code.match(URL_IN_CODE) ?? [])];
    calls.push(...(urls.length ? urls.map((read) => ({ read })) : [{ read: "" }]));
  }
  return calls.slice(0, MAX_CALLS);
}

const readLine = (c: WebCall) =>
  "search" in c
    ? c.search
      ? `Searched the web for "${c.search}"`
      : "Searched the web"
    : `Read ${c.read || "a web page"}`;
const CODE_READ = "Ran code that can search and read the web";

/**
 * Code whose own calls came back with it (a paused turn's) is told by those. Code counts as a read even
 * when no call shows in it: a URL in a variable or a helper function hides one.
 */
export function webReads(content: Anthropic.Beta.BetaContentBlock[]): string[] {
  const told = new Set(
    content.flatMap((b) =>
      b.type === "server_tool_use" && b.caller && "tool_id" in b.caller ? [b.caller.tool_id] : [],
    ),
  );
  return content.flatMap((b) => {
    if (b.type !== "server_tool_use" || told.has(b.id)) return [];
    const calls = webCalls(b.name, b.input);
    if (!calls.length && CODE_TOOLS.includes(b.name)) return [CODE_READ];
    return calls.map(readLine);
  });
}

/**
 * A server tool call that hasn't run: called alongside client tools, it runs once their results are
 * back, and until then the API takes nothing but those results.
 */
export function serverToolWaiting(content: Anthropic.Beta.BetaContentBlock[]): boolean {
  const done = new Set(
    content.flatMap((b) =>
      "tool_use_id" in b && b.type.endsWith("_tool_result") ? [b.tool_use_id] : [],
    ),
  );
  return content.some((b) => b.type === "server_tool_use" && !done.has(b.id));
}

/**
 * The untrusted text to screen: pages fetched (a PDF as it came), search results' titles (their text
 * comes encrypted), what the web tools' code printed, and files viewed in its container.
 */
export function webTexts(
  content: Anthropic.Beta.BetaContentBlock[],
): { source: string; text: Readable }[] {
  const out: { source: string; text: Readable }[] = [];
  for (const b of content) {
    if (b.type === "web_fetch_tool_result" && b.content.type === "web_fetch_result") {
      const { source, title } = b.content.content;
      out.push({
        source: `Read ${b.content.url}`,
        text: source.type === "text" ? `${title ?? ""}\n${source.data}` : { pdf: source.data },
      });
    } else if (
      b.type === "text_editor_code_execution_tool_result" &&
      b.content.type === "text_editor_code_execution_view_result"
    ) {
      out.push({ source: CODE_READ, text: b.content.content });
    } else if (b.type === "web_search_tool_result" && Array.isArray(b.content)) {
      const titles = b.content.map((r) => `${r.title} (${r.url})`).join("\n");
      out.push({ source: "Web search results", text: titles });
    } else if (
      (b.type === "code_execution_tool_result" && b.content.type === "code_execution_result") ||
      (b.type === "bash_code_execution_tool_result" &&
        b.content.type === "bash_code_execution_result")
    )
      out.push({ source: CODE_READ, text: `${b.content.stdout}\n${b.content.stderr}` });
  }
  return out;
}

/** Sent with the next request of the same reply or task: code paused mid-run carries on in it. */
export const containerOf = (res: Anthropic.Beta.BetaMessage, before?: string) =>
  res.container?.id ?? before;
