// Built-in tools for the chat thread (PLAN.md §5.5): memory, history search, desktop tasks, schedules.
import type Anthropic from "@anthropic-ai/sdk";
import { describeCron, type Schedule, SKILL_NAME } from "@hatbot/shared";
import { z } from "zod";
import type { Attachments } from "../attachments";
import type { Db } from "../db";
import { type DesktopAgent, DesktopError } from "../desktop/client";
import type { EventBus } from "../events";
import { HATBOT, MemoryError, type MemoryStore } from "../memory/store";
import type { PluginTool } from "../plugins/plugin";
import { describeCall, type Plugins, runPluginTool } from "../plugins/registry";
import { ScheduleError, type Schedules } from "../schedules";
import type { Tasks } from "../tasks/service";
import { skillPath } from "../teach/skills";
import type { Triggers } from "../triggers";

export type ToolContext = {
  db: Db;
  memory: MemoryStore;
  events: EventBus;
  tasks?: Tasks;
  schedules?: Schedules;
  triggers?: Triggers;
  /** The chat reply being written; a task it starts shows under it. */
  messageId?: number;
  /** The conversation the reply is in: history search leaves it out, since the model already has it. */
  episodeId?: number;
  /** The background task running the tool: files it sends go on the task. */
  taskId?: number;
  attachments?: Attachments;
  /** The desktop, whose sandbox send_file takes files from. */
  desktop?: DesktopAgent;
  /** Adds a schedule's card to the thread. */
  scheduleCard?: (s: Schedule) => void;
  plugins?: Plugins;
  /**
   * What untrusted content the conversation first read, or null; tasks it starts begin tainted
   * (PLAN.md §6.1).
   */
  tainted?: () => string | null;
  /** Marks the conversation as having read untrusted content: `by`. */
  taint?: (by: string) => void;
  /** Your own latest messages in this conversation, for a task's approval check. */
  ownerSaid?: () => string;
  /** Runs a plugin tool that changes something, after its checks and your approval if it needs one. */
  gated?: (
    t: PluginTool,
    input: unknown,
    signal: AbortSignal,
  ) => Promise<{ content: string; isError: boolean }>;
};

export const DesktopTaskInput = z.object({
  title: z
    .string()
    .min(1)
    .max(80)
    .describe('Short title for the card, e.g. "Book a table at Luigi\'s"'),
  goal: z
    .string()
    .min(1)
    .max(4000)
    .describe("What to do, with every detail from the conversation it needs"),
  success_criteria: z.string().max(1000).describe("How to tell it's done"),
  skill: z
    .string()
    .regex(SKILL_NAME)
    .optional()
    .describe(
      "A skill to follow, when one fits: its name, from skills/<name>.md. The desktop model gets its steps; put the values for its {{placeholders}} in the goal",
    ),
});

/** Why a desktop task can't use `skill`, or null if it can. */
export async function missingSkill(memory: MemoryStore, skill?: string): Promise<string | null> {
  if (!skill || (await memory.exists(skillPath(skill)))) return null;
  return `There's no skill called "${skill}" (skills/${skill}.md). Check INDEX.md, or leave skill out.`;
}

export const RunTaskInput = z.object({
  title: z
    .string()
    .min(1)
    .max(80)
    .describe('Short title, e.g. "Restart Jellyfin" or "Fix the failing CI on hatbot"'),
  goal: z
    .string()
    .min(1)
    .max(4000)
    .describe(
      "What to do and what to report back, with every detail from the conversation it needs",
    ),
  effort: z
    .enum(["medium", "high"])
    .optional()
    .describe(
      'Leave out for routine work. "medium" for writing or changing code; "high" when the owner asks for it or an earlier attempt failed',
    ),
});

const local = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) : "–";
const scheduleLine = (s: Schedule) =>
  `#${s.id} "${s.name}": ${s.cron ? `${describeCron(s.cron)} (cron ${s.cron})` : `once, ${local(s.runAt)}`}; ${s.enabled ? `next run ${local(s.nextRunAt)}` : "off"}${s.lastRunAt ? `; last ran ${local(s.lastRunAt)}${s.lastTaskId ? ` (task #${s.lastTaskId})` : ""}` : ""}\n  Does: ${s.prompt}`;
/** Why a task the chat starts is tainted, from what the chat had read. */
const chatTaint = (by: string | null | undefined) => by && `The chat had read: ${by}`;

const scheduleWhen = {
  cron: z
    .string()
    .optional()
    .describe(
      'Repeating: five-field cron (minute hour day-of-month month day-of-week) in the owner\'s local time, e.g. "0 8 * * *" for every day at 08:00, "30 7 * * 1-5" for weekdays at 07:30. At most every 5 minutes',
    ),
  at: z.string().optional().describe('Once: local date and time, e.g. "2026-10-11T08:00"'),
};

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
    run: async ({ query, after, before }, { db, episodeId }) => {
      const terms = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
      if (!terms.length) return "No searchable words in the query.";
      // Not the conversation you're in: the message asking would otherwise be the best match.
      const rows = db
        .query<
          { role: string; text: string; created_at: string },
          [string, string, string, number]
        >(
          `SELECT m.role, m.text, m.created_at FROM messages_fts f JOIN messages m ON m.id = f.rowid
           WHERE messages_fts MATCH ? AND m.created_at >= ? AND m.created_at < ?
           AND m.episode_id IS NOT ?
           ORDER BY rank LIMIT 20`,
        )
        .all(
          terms.map((t) => `"${t}"`).join(" "),
          after ?? "0000",
          before ?? "9999",
          episodeId ?? -1,
        );
      if (!rows.length) return "No matches.";
      return rows
        .map(
          (r) =>
            `[${r.created_at.slice(0, 16).replace("T", " ")}] ${r.role}: ${r.text.slice(0, 1500)}`,
        )
        .join("\n\n");
    },
  }),
  def({
    name: "send_file",
    description:
      "Send the owner a file from the desktop's sandbox (a path relative to its home, as code_run sees it): a chart, a CSV, a converted document. It shows under your reply, for them to open or save. Up to 25 MB.",
    schema: z.object({
      path: z.string().min(1).max(500).describe('The file in the sandbox, e.g. "out/chart.png"'),
      name: z
        .string()
        .max(200)
        .optional()
        .describe("The name the owner sees, if not the file's own"),
    }),
    run: async ({ path, name }, { attachments, desktop, messageId, taskId }) => {
      if (!attachments || !desktop?.configured)
        throw new DesktopError("The desktop isn't set up.", 0);
      const target = taskId ? { taskId } : { messageId };
      const a = await attachments.fromDesktop(desktop, { path, name }, target);
      return `Sent "${a.name}" (${a.mediaType}).`;
    },
  }),
  def({
    name: "run_desktop_task",
    description:
      "Start a task on your Linux desktop (Chromium, plus a shell for commands and experiments), for anything that needs a browser or a sandbox to try things in: booking, buying, filling in forms, pages that need a login, running a script. To look something up, web_search and web_fetch are quicker. It runs in the background on a separate model and its progress and result show under your reply; the owner can watch it live and approves consequential steps. You're told how it ended at the start of a later turn. Give it everything it needs to know: it can't see this conversation.",
    schema: DesktopTaskInput,
    run: async ({ title, goal, success_criteria, skill }, { tasks, messageId, memory }) => {
      if (!tasks) return "Desktop tasks aren't available.";
      const missing = await missingSkill(memory, skill);
      if (missing) return missing;
      const task = tasks.createDesktopTask({
        title,
        goal,
        successCriteria: success_criteria,
        skill,
        origin: "chat",
        message: messageId,
      });
      return `Started task #${task.id}. It's running in the background; the owner sees its progress and result under this reply. Don't wait for it.`;
    },
  }),
  def({
    name: "run_task",
    description:
      "Start a background task for longer work: several steps that depend on each other, anything that takes more than a minute or two, writing code, or work that should go on after this reply. It gets your memory, every tool your plugins offer and the desktop, and it asks the owner before risky steps. Its progress and result show under your reply; you're told how it ended at the start of a later turn. It can't see this conversation, so give it everything it needs. For a command or two, use the plugin tools yourself instead.",
    schema: RunTaskInput,
    run: async ({ title, goal, effort }, { tasks, messageId, tainted, ownerSaid }) => {
      if (!tasks) return "Tasks aren't available.";
      const task = tasks.createBackgroundTask({
        title,
        goal,
        origin: "chat",
        effort,
        message: messageId,
        taintedBy: chatTaint(tainted?.()),
        request: ownerSaid?.(),
      });
      if (!task) return "The task couldn't start.";
      return `Started task #${task.id}. It's running in the background; the owner sees its progress and result under this reply. Don't wait for it.`;
    },
  }),
  def({
    name: "get_task",
    description: "The status of a task, its summary if it ended, and its last few steps.",
    schema: z.object({ id: z.number().int() }),
    run: async ({ id }, { tasks, taint }) => {
      const task = tasks?.get(id);
      if (!tasks || !task) return `No task #${id}.`;
      // Its summary and steps carry what it read.
      if (task.tainted) taint?.(`Task #${task.id} "${task.title}"`);
      const steps = tasks
        .steps(id)
        .filter((s) => s.kind !== "screenshot")
        .slice(-8)
        .map((s) => `- ${s.name}${s.detail ? `: ${s.detail.slice(0, 200)}` : ""}`)
        .join("\n");
      return `Task #${task.id} "${task.title}": ${task.status}, $${task.costUsd.toFixed(2)} spent.${task.summary ? `\nSummary: ${task.summary}` : ""}${steps ? `\nLast steps:\n${steps}` : ""}`;
    },
  }),
  def({
    name: "schedule_create",
    description:
      "Schedule a background task that runs on its own, repeating (cron) or once (at). Each run gets your memory and tools, can use the desktop, and reports back in this thread, with a notification when there's something to tell. Write `prompt` as complete instructions for that future run: it can't see this conversation. If the owner's timing is vague, ask before creating it. The owner sees it in Schedules, where they can change or turn it off.",
    schema: z.object({
      name: z.string().min(1).max(80).describe('Short name, e.g. "Framework 16 stock check"'),
      prompt: z
        .string()
        .min(1)
        .max(4000)
        .describe(
          "What each run does and when it should tell the owner, with every detail it needs",
        ),
      ...scheduleWhen,
    }),
    run: async ({ name, prompt, cron, at }, { schedules, scheduleCard, tainted }) => {
      if (!schedules) return "Schedules aren't available.";
      if (Boolean(cron) === Boolean(at)) return "Give either cron or at.";
      const s = schedules.create({ name, prompt, cron, at }, "chat", tainted?.() ?? null);
      scheduleCard?.(s);
      return `Created schedule ${scheduleLine(s)}`;
    },
  }),
  def({
    name: "schedule_list",
    description: "List every schedule with its timing, next run and what it does.",
    schema: z.object({}),
    run: async (_, { schedules }) =>
      schedules?.list().map(scheduleLine).join("\n") || "No schedules.",
  }),
  def({
    name: "schedule_update",
    description:
      "Change a schedule: its name, what it does, its timing, or turn it on or off. Only the fields you give change.",
    schema: z.object({
      id: z.number().int(),
      name: z.string().min(1).max(80).optional(),
      prompt: z.string().min(1).max(4000).optional(),
      enabled: z.boolean().optional(),
      ...scheduleWhen,
    }),
    run: async ({ id, ...patch }, { schedules, tainted }) => {
      if (patch.cron && patch.at) return "Give either cron or at, not both.";
      const s = schedules?.update(id, patch, { via: "chat", taintedBy: tainted?.() ?? null });
      return s ? `Updated schedule ${scheduleLine(s)}` : `No schedule #${id}.`;
    },
  }),
  def({
    name: "schedule_delete",
    description: "Delete a schedule. Its past runs stay in the Tasks list.",
    schema: z.object({ id: z.number().int() }),
    run: async ({ id }, { schedules }) =>
      schedules?.delete(id) ? `Deleted schedule #${id}.` : `No schedule #${id}.`,
  }),
  def({
    name: "trigger_list",
    description:
      "List the webhooks and Uptime Kuma alert hooks that start background tasks, with what each run does. The owner creates them in Schedules & Triggers.",
    schema: z.object({}),
    run: async (_, { triggers }) =>
      triggers
        ?.list()
        .map(
          (t) =>
            `#${t.id} "${t.name}" (${t.kind === "kuma" ? "Uptime Kuma" : "webhook"}${t.trusted ? ", trusted" : ""}${t.enabled ? "" : ", off"}${t.confirmChecks ? `, waits for ${t.confirmChecks} more failed check${t.confirmChecks > 1 ? "s" : ""}` : ""})${t.lastFiredAt ? `; last event ${local(t.lastFiredAt)}` : ""}\n  Does: ${t.prompt}`,
        )
        .join("\n") || "No triggers.",
  }),
  def({
    name: "trigger_update",
    description:
      "Change what a trigger's runs do, rename it, turn it on or off, or how many more failed checks an Uptime Kuma alert waits for. Only the fields you give change.",
    schema: z.object({
      id: z.number().int(),
      name: z.string().min(1).max(80).optional(),
      prompt: z.string().min(1).max(4000).optional(),
      enabled: z.boolean().optional(),
      confirmChecks: z
        .number()
        .int()
        .min(0)
        .max(2)
        .optional()
        .describe(
          "Uptime Kuma only: wait for this many more of the monitor's checks before acting on a down alert, so a blip that recovers starts nothing. 0 acts at once.",
        ),
    }),
    run: async ({ id, ...patch }, { triggers, tainted }) => {
      // A trigger's runs trust its instructions; untrusted content mustn't get to write them.
      if (patch.prompt !== undefined && tainted?.())
        return "Not changed: this conversation has read untrusted content, so it can't rewrite what a trigger does. Ask the owner to change it in Schedules & Triggers.";
      const t = triggers?.update(id, patch);
      return t ? `Updated trigger #${t.id} "${t.name}".` : `No trigger #${id}.`;
    },
  }),
];

/** A tool definition as sent to the API. */
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

/** The core's tool definitions. Order and content must stay stable to keep the cache. */
export const TOOL_PARAMS: Anthropic.Beta.BetaTool[] = TOOLS.map(toolParam);

/**
 * Runs a chat tool call: a core tool, or a plugin's tool (one that changes something goes through
 * `gated`). Input is validated here: with eager input streaming the API doesn't. `untrusted`: the output
 * was untrusted content.
 */
export async function runTool(
  name: string,
  input: unknown,
  ctx: ToolContext,
  signal: AbortSignal = new AbortController().signal,
): Promise<{ content: string; isError: boolean; untrusted?: boolean }> {
  const tool =
    TOOLS.find((t) => t.name === name) ??
    TOOLS.find((t) => t.name.toLowerCase() === name.toLowerCase());
  if (!tool) {
    const plugin = ctx.plugins?.tools().find((t) => t.name === name);
    if (plugin?.access === "write") {
      if (!ctx.gated) return { content: `${name} can't run here.`, isError: true };
      return ctx.gated(plugin, input, signal);
    }
    if (plugin) {
      const r = await runPluginTool(plugin, input, { task: null, signal });
      if (r.untrusted) ctx.taint?.(describeCall(plugin, input));
      return r;
    }
    const names = [...TOOLS, ...(ctx.plugins?.tools() ?? [])].map((t) => t.name);
    return { content: `Unknown tool "${name}". Available: ${names.join(", ")}`, isError: true };
  }
  const parsed = tool.schema.safeParse(input);
  if (!parsed.success)
    return { content: `Invalid input: ${z.prettifyError(parsed.error)}`, isError: true };
  try {
    // biome-ignore lint/suspicious/noExplicitAny: each tool's run matches its own schema
    return { content: await tool.run(parsed.data as any, ctx), isError: false };
  } catch (err) {
    if (err instanceof MemoryError || err instanceof ScheduleError || err instanceof DesktopError)
      return { content: err.message, isError: true };
    console.error(`tool ${name} failed`, err);
    return { content: "The tool failed with an internal error.", isError: true };
  }
}

/**
 * The core tools an incognito conversation gets: lookups that leave nothing behind. Not history search,
 * which it doesn't see, or anything that writes or starts work that outlives it.
 */
export const INCOGNITO_TOOLS = [
  "memory_list",
  "memory_read",
  "memory_search",
  "schedule_list",
  "trigger_list",
];

/** Core tools that only look things up, so several can run at once. */
export const LOOKUP_TOOLS = ["memory_list", "memory_read", "memory_search", "search_history"];

/**
 * Runs a turn's tool calls in order, except that calls in a row that may run together do: what
 * `parallel` says may (true, or the thing a change acts on) and, for changes, each on a different
 * thing. Lookups and changes don't share a batch. Results come back in the calls' order.
 */
export async function inBatches<C, R>(
  calls: C[],
  parallel: (call: C) => boolean | string,
  run: (call: C) => Promise<R>,
): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < calls.length; ) {
    const first = parallel(calls[i] as C);
    const targets = new Set<string>();
    if (typeof first === "string") targets.add(first);
    let j = i + 1;
    while (first !== false && j < calls.length) {
      const next = parallel(calls[j] as C);
      if (typeof next !== typeof first || next === false) break;
      if (typeof next === "string") {
        if (targets.has(next)) break;
        targets.add(next);
      }
      j++;
    }
    out.push(...(await Promise.all(calls.slice(i, j).map(run))));
    i = j;
  }
  return out;
}

/** The core's tool names, which plugin tools can't take. */
export const CORE_TOOL_NAMES = [
  ...TOOLS.map((t) => t.name),
  "finish_task",
  "confirm_intent",
  "request_takeover",
];

/**
 * Anthropic's web search and fetch, run by the API itself. The basic versions: dynamic filtering would
 * bring a code container into every conversation. Fetch only takes URLs already in the conversation.
 */
export const WEB_TOOLS: Anthropic.Beta.BetaToolUnion[] = [
  { type: "web_search_20250305", name: "web_search", max_uses: 8 },
  { type: "web_fetch_20250910", name: "web_fetch", max_uses: 8, max_content_tokens: 30000 },
];

/** What a reply looked up on the web, in a line each: `Searched the web for "x"`, `Read https://…`. */
export function webReads(content: Anthropic.Beta.BetaContentBlock[]): string[] {
  return content.flatMap((b) => {
    if (b.type !== "server_tool_use") return [];
    if (b.name === "web_search") return [`Searched the web for "${String(b.input.query ?? "")}"`];
    if (b.name === "web_fetch") return [`Read ${String(b.input.url ?? "a web page")}`];
    return [];
  });
}
