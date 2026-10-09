// Built-in tools for the chat thread (PLAN.md §5.5). M1: memory and history search.
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { Db } from "../db";
import type { EventBus } from "../events";
import { HATBOT, MemoryError, type MemoryStore } from "../memory/store";

export type ToolContext = { db: Db; memory: MemoryStore; events: EventBus };

type ToolDef<S extends z.ZodType> = {
  name: string;
  description: string;
  schema: S;
  run: (input: z.infer<S>, ctx: ToolContext) => Promise<string>;
};

const def = <S extends z.ZodType>(t: ToolDef<S>) => t;

export const TOOLS = [
  def({
    name: "memory_list",
    description: "List every file in your memory repo with its size in bytes.",
    schema: z.object({}),
    run: async (_, { memory }) =>
      (await memory.tree()).map((f) => `${f.path} (${f.size} B)`).join("\n") || "(empty)",
  }),
  def({
    name: "memory_read",
    description: "Read a file from your memory repo.",
    schema: z.object({
      path: z.string().describe("Path relative to the repo root, e.g. projects/hatbot.md"),
    }),
    run: async ({ path }, { memory }) => memory.read(path),
  }),
  def({
    name: "memory_write",
    description:
      "Create or replace a markdown file in your memory repo. Write the whole file. Each write is a git commit the owner can see and revert. Keep INDEX.md current when you add or remove files.",
    schema: z.object({
      path: z.string().describe("Path relative to the repo root, ending in .md"),
      content: z.string().describe("The complete new file content"),
      reason: z.string().describe("Short commit message saying what changed and why"),
    }),
    run: async ({ path, content, reason }, { memory, events }) => {
      const sha = await memory.write(path, content, HATBOT, reason);
      if (!sha) return "No change: the file already had this content.";
      events.emit({ type: "memory.committed", sha, message: reason, author: HATBOT.name });
      return `Saved ${path} (commit ${sha.slice(0, 7)}).`;
    },
  }),
  def({
    name: "memory_delete",
    description: "Delete a file from your memory repo. It stays in git history.",
    schema: z.object({ path: z.string(), reason: z.string().describe("Short commit message") }),
    run: async ({ path, reason }, { memory, events }) => {
      const sha = await memory.delete(path, HATBOT, reason);
      if (sha) events.emit({ type: "memory.committed", sha, message: reason, author: HATBOT.name });
      return `Deleted ${path}.`;
    },
  }),
  def({
    name: "memory_search",
    description: "Search your memory repo for a phrase (case-insensitive). Returns matching lines.",
    schema: z.object({ query: z.string().min(1) }),
    run: async ({ query }, { memory }) =>
      (await memory.search(query)).map((h) => `${h.path}:${h.line}: ${h.text}`).join("\n") ||
      "No matches.",
  }),
  def({
    name: "search_history",
    description:
      "Full-text search over the whole chat history with the owner, including messages older than what you can see. Use it when the owner refers to something from an earlier conversation.",
    schema: z.object({
      query: z.string().min(1).describe("Words to search for"),
      after: z.string().optional().describe("Only messages on or after this date, YYYY-MM-DD"),
      before: z.string().optional().describe("Only messages before this date, YYYY-MM-DD"),
    }),
    run: async ({ query, after, before }, { db }) => {
      const terms = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
      if (!terms.length) return "No searchable words in the query.";
      const rows = db
        .query<{ role: string; text: string; created_at: string }, [string, string, string]>(
          `SELECT m.role, m.text, m.created_at FROM messages_fts f JOIN messages m ON m.id = f.rowid
           WHERE messages_fts MATCH ? AND m.created_at >= ? AND m.created_at < ?
           ORDER BY rank LIMIT 20`,
        )
        .all(terms.map((t) => `"${t}"`).join(" "), after ?? "0000", before ?? "9999");
      if (!rows.length) return "No matches.";
      return rows
        .map(
          (r) =>
            `[${r.created_at.slice(0, 16).replace("T", " ")}] ${r.role}: ${r.text.slice(0, 1500)}`,
        )
        .join("\n\n");
    },
  }),
];

/** Tool definitions as sent to the API. Order and content must stay stable to keep the cache. */
export const TOOL_PARAMS: Anthropic.Beta.BetaTool[] = TOOLS.map((t) => ({
  name: t.name,
  description: t.description,
  input_schema: z.toJSONSchema(t.schema) as Anthropic.Beta.BetaTool.InputSchema,
  eager_input_streaming: true,
}));

/** Runs a tool call. Input is validated here: with eager input streaming the API doesn't. */
export async function runTool(
  name: string,
  input: unknown,
  ctx: ToolContext,
): Promise<{ content: string; isError: boolean }> {
  const tool =
    TOOLS.find((t) => t.name === name) ??
    TOOLS.find((t) => t.name.toLowerCase() === name.toLowerCase());
  if (!tool)
    return {
      content: `Unknown tool "${name}". Available: ${TOOLS.map((t) => t.name).join(", ")}`,
      isError: true,
    };
  const parsed = tool.schema.safeParse(input);
  if (!parsed.success)
    return { content: `Invalid input: ${z.prettifyError(parsed.error)}`, isError: true };
  try {
    // biome-ignore lint/suspicious/noExplicitAny: each tool's run matches its own schema
    return { content: await tool.run(parsed.data as any, ctx), isError: false };
  } catch (err) {
    if (err instanceof MemoryError) return { content: err.message, isError: true };
    console.error(`tool ${name} failed`, err);
    return { content: "The tool failed with an internal error.", isError: true };
  }
}
