// Built-in tools for the chat thread (PLAN.md §5.5): memory, history search, desktop tasks, schedules.
import type Anthropic from "@anthropic-ai/sdk";
import {
  type Bot,
  describeCron,
  HATBOT_ID,
  minWatchMinutes,
  type Schedule,
  SKILL_NAME,
  type Source,
  type WatchSource,
} from "@hatbot/shared";
import { z } from "zod";
import type { Attachments } from "../attachments";
import { type Bots, botFolder } from "../bots";
import type { Db } from "../db";
import { type DesktopAgent, DesktopError } from "../desktop/client";
import type { EventBus } from "../events";
import type { Proposals } from "../memory/proposals";
import { HATBOT, MemoryError, type MemoryStore } from "../memory/store";
import { NEGOTIATE_TOOL_NAMES } from "../negotiate/names";
import type { PluginTool } from "../plugins/plugin";
import { describeCall, type Plugins, runPluginTool } from "../plugins/registry";
import { ScheduleError, type Schedules } from "../schedules";
import { refreshing } from "../tasks/research-goal";
import type { Tasks } from "../tasks/service";
import { skillPath } from "../teach/skills";
import type { Triggers } from "../triggers";
import { conditionOf, WatchError, type Watchers, watcherLine } from "../watch/service";

export type ToolContext = {
  db: Db;
  memory: MemoryStore;
  events: EventBus;
  /** The bot calling: whose memory commits these are, and whose tasks and schedules it starts. */
  bot?: Bot;
  bots?: Bots;
  /** The chat the reply is in: where tasks it starts report. */
  conversationId?: number;
  tasks?: Tasks;
  schedules?: Schedules;
  triggers?: Triggers;
  watchers?: Watchers;
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
  /** The plugin tools this reply was offered, with negotiation's; all of the plugins' without it. */
  pluginTools?: PluginTool[];
  /** Where writes to skills and indexes go while the conversation or task is tainted. */
  proposals?: Proposals;
  /**
   * What untrusted content the conversation or task first read, or null; tasks it starts begin tainted
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

export const AskBotInput = z.object({
  bot: z.string().min(1).max(40).describe("The bot's name or id"),
  request: z
    .string()
    .min(1)
    .max(4000)
    .describe(
      "What it should do and what to report back, with every detail from the conversation it needs",
    ),
});

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

export const ResearchInput = z.object({
  title: z.string().min(1).max(80).describe('Short title, e.g. "Quiet NAS for four drives"'),
  question: z
    .string()
    .min(1)
    .max(4000)
    .describe(
      "What to find out, with everything from the conversation that bears on it: what it's for, the budget, where the owner is, must-haves, what they already know or ruled out, and what the answer should cover",
    ),
  previous: z
    .string()
    .max(300)
    .optional()
    .describe(
      "To refresh an earlier report: its path in memory. The task checks it again and says what changed",
    ),
});

const local = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) : "–";
const scheduleLine = (s: Schedule) =>
  `#${s.id} "${s.name}": ${s.cron ? `${describeCron(s.cron)} (cron ${s.cron})` : `once, ${local(s.runAt)}`}; ${s.enabled ? `next run ${local(s.nextRunAt)}` : "off"}${s.lastRunAt ? `; last ran ${local(s.lastRunAt)}${s.lastTaskId ? ` (task #${s.lastTaskId})` : ""}` : ""}\n  Does: ${s.prompt}`;
/** "Runs as Coder", for a schedule or trigger another bot runs. */
const whose = (botId: string, bot?: Bot, bots?: Bots) =>
  bots && botId !== (bot?.id ?? HATBOT_ID) ? `\n  Runs as: ${bots.nameOf(botId)}` : "";

/**
 * Who a memory change is by: the bot calling. Another bot's folder (bots/<id>/) is that bot's own, so
 * it's refused.
 */
function authorOf(ctx: ToolContext, path: string) {
  const id = ctx.bot?.id ?? HATBOT_ID;
  const theirs = /^bots\/([^/]+)\//.exec(path.replace(/^\.\//, ""))?.[1];
  if (theirs && `bots/${theirs}` !== botFolder(id))
    throw new MemoryError(
      `${path} is in ${ctx.bots?.nameOf(theirs) ?? theirs}'s own memory folder; leave it to them.`,
    );
  return ctx.bots?.author(id) ?? HATBOT;
}

/** Files every later chat and task reads and trusts: skills, and the memory indexes. */
const TRUSTED_FILE = /^(skills\/.+|INDEX\.md|bots\/[^/]+\/INDEX\.md)$/;

/**
 * A write (or, content null, a delete) to a trusted file after reading untrusted content becomes a
 * proposal you apply, so injected text can't make itself trusted (PLAN.md §6.1). The tool's reply,
 * or null to write it directly.
 */
async function held(
  ctx: ToolContext,
  path: string,
  content: string | null,
  reason: string,
): Promise<string | null> {
  const by = ctx.tainted?.();
  const { rel } = ctx.memory.resolve(path);
  if (!by || !TRUSTED_FILE.test(rel)) return null;
  if (!ctx.proposals)
    throw new MemoryError(`${rel} can't be changed after reading untrusted content.`);
  const p = await ctx.proposals.hold(rel, content, reason, by);
  if (!p)
    return content === null
      ? `Nothing to delete: ${rel} doesn't exist.`
      : "No change: the file already had this content.";
  return "Saved as a proposal; the owner applies it. After reading untrusted content, changes to skills and INDEX.md wait for them.";
}

/** Why a task the chat starts is tainted, from what the chat had read. */
const chatTaint = (by: string | null | undefined) => by && `The chat had read: ${by}`;

/** A change that wasn't made: its message is for the model. */
class NotChanged extends Error {}

/**
 * Deleting or switching off a schedule, watcher or trigger after reading untrusted content waits for
 * approval (Haiku's review, or you), as a plugin's change does (PLAN.md §6.1): injected text mustn't
 * quietly stop what looks after the homelab. `change` runs at once otherwise.
 */
async function approved(
  ctx: ToolContext,
  signal: AbortSignal,
  call: { name: string; input: unknown; what: string },
  change: () => string | Promise<string>,
): Promise<string> {
  if (!ctx.tainted?.()) return change();
  if (!ctx.gated)
    throw new NotChanged(
      "Not changed: after reading untrusted content this needs the owner's approval, which can't be asked here.",
    );
  const r = await ctx.gated(
    {
      name: call.name,
      description: "",
      schema: z.unknown(),
      access: "write",
      label: call.what,
      describe: () => call.what,
      // Not a command on the homelab: it doesn't count towards the chat's limit.
      commands: () => 0,
      run: async () => "",
    },
    call.input,
    signal,
  );
  if (r.isError) throw new NotChanged(r.content);
  // With your note, if you wrote one.
  return `${await change()}${r.content}`;
}

const watchFields = {
  render: z
    .boolean()
    .optional()
    .describe(
      'A page: load it in a headless browser on the desktop and run its scripts first, for a page that fills in with JavaScript (empty or "Loading…" without). Slower: such a watcher looks every 15 minutes at most. Sites with bot protection block it too',
    ),
  selector: z
    .string()
    .optional()
    .describe(
      'A page: the text of the elements this CSS selector matches, e.g. ".price" or "#stock"',
    ),
  path: z
    .string()
    .optional()
    .describe(
      'JSON (an API, or a tool that answers in JSON): the value at this path, e.g. "items.0.price"',
    ),
  pattern: z
    .string()
    .optional()
    .describe(
      'A regular expression over the text (case-insensitive): its first group is the value, e.g. "Price:\\s*([\\d.,]+)"',
    ),
  when: z
    .enum(["changed", "contains", "missing", "below", "above"])
    .optional()
    .describe(
      'When a new value counts: "changed" (any change; the default), "contains"/"missing" the text, or a number "below"/"above" the value. Only a move into it counts, not every check while it holds',
    ),
  text: z.string().optional().describe('For "contains" and "missing"'),
  value: z.number().optional().describe('For "below" and "above"'),
  every_minutes: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("How often to look, at least 5 (15 with render); 60 if left out"),
  once: z.boolean().optional().describe("Switch off after the first time it counts"),
  prompt: z
    .string()
    .max(4000)
    .optional()
    .describe(
      "What to do when it counts, as a background task that's told the old and new value and can't see this conversation. Leave out to just tell the owner",
    ),
};

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
  run: (input: z.infer<S>, ctx: ToolContext, signal: AbortSignal) => Promise<string>;
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
    run: async ({ path, content, reason }, ctx) => {
      const author = authorOf(ctx, path);
      const proposed = await held(ctx, path, content, reason);
      if (proposed) return proposed;
      const sha = await ctx.memory.write(path, content, author, reason);
      if (!sha) return "No change: the file already had this content.";
      ctx.events.emit({ type: "memory.committed", sha, message: reason, author: author.name });
      return `Saved ${path} (commit ${sha.slice(0, 7)}).`;
    },
  }),
  def({
    name: "memory_delete",
    description: "Delete a file from your memory repo. It stays in git history.",
    schema: z.object({ path: z.string(), reason: z.string().describe("Short commit message") }),
    run: async ({ path, reason }, ctx) => {
      const author = authorOf(ctx, path);
      const proposed = await held(ctx, path, null, reason);
      if (proposed) return proposed;
      const sha = await ctx.memory.delete(path, author, reason);
      if (sha)
        ctx.events.emit({ type: "memory.committed", sha, message: reason, author: author.name });
      return `Deleted ${path}.`;
    },
  }),
  def({
    name: "memory_search",
    description:
      "Search your memory by words, in any form (runs finds run). The best-matching sections first, each as file:line: excerpt.",
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
    run: async ({ query, after, before }, { db, episodeId, bot, bots }) => {
      const terms = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
      if (!terms.length) return "No searchable words in the query.";
      // Not the conversation you're in: the message asking would otherwise be the best match. Only
      // the chats this bot is in.
      const rows = db
        .query<
          { role: string; bot_id: string | null; text: string; created_at: string },
          [string, string, string, number, string]
        >(
          `SELECT m.role, m.bot_id, m.text, m.created_at FROM messages_fts f JOIN messages m ON m.id = f.rowid
           WHERE messages_fts MATCH ? AND m.created_at >= ? AND m.created_at < ?
           AND m.episode_id IS NOT ?
           AND m.conversation_id IN (SELECT conversation_id FROM conversation_bots WHERE bot_id = ?)
           ORDER BY rank LIMIT 20`,
        )
        .all(
          terms.map((t) => `"${t}"`).join(" "),
          after ?? "0000",
          before ?? "9999",
          episodeId ?? -1,
          bot?.id ?? HATBOT_ID,
        );
      if (!rows.length) return "No matches.";
      return rows
        .map(
          (r) =>
            `[${r.created_at.slice(0, 16).replace("T", " ")}] ${r.role === "user" ? "owner" : (bots?.nameOf(r.bot_id ?? HATBOT_ID) ?? "assistant")}: ${r.text.slice(0, 1500)}`,
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
      "Start a task on your Linux desktop (Chromium, plus a shell), for anything that needs a real browser: booking, buying, filling in forms, pages that need a login. To compute or run a script, use code_run when the Code plugin is on; to look something up, web_search and web_fetch are quicker. It runs in the background on a separate model and its progress and result show under your reply; the owner can watch it live and approves consequential steps. You're told how it ended at the start of a later turn. Give it everything it needs to know: it can't see this conversation.",
    schema: DesktopTaskInput,
    run: async (
      { title, goal, success_criteria, skill },
      { tasks, messageId, memory, bot, conversationId },
    ) => {
      if (!tasks) return "Desktop tasks aren't available.";
      const missing = await missingSkill(memory, skill);
      if (missing) return missing;
      const task = tasks.createDesktopTask({
        title,
        goal,
        successCriteria: success_criteria,
        skill,
        origin: "chat",
        botId: bot?.id,
        conversationId,
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
    run: async (
      { title, goal, effort },
      { tasks, messageId, tainted, ownerSaid, bot, conversationId },
    ) => {
      if (!tasks) return "Tasks aren't available.";
      const task = tasks.createBackgroundTask({
        title,
        goal,
        origin: "chat",
        botId: bot?.id,
        conversationId,
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
    name: "research",
    description:
      "Start a research task, for a question that needs many searches and pages: comparing products or options, prices across shops, a technical question whose sources disagree. Opus plans it and hands parts to helpers that search at once, the numbers are checked against their sources, and it ends in a report with numbered sources, saved in memory and attached. It takes a few minutes and costs about $1–3. Its short answer shows under your reply. It can't see this conversation, so put everything that bears on the question in it. For a fact or two, search yourself instead.",
    schema: ResearchInput,
    run: async (
      { title, question, previous },
      { tasks, memory, messageId, tainted, ownerSaid, bot, conversationId },
    ) => {
      if (!tasks) return "Tasks aren't available.";
      if (previous && !(await memory.exists(previous)))
        return `There's no report at ${previous}. Check the path, or leave previous out.`;
      const task = tasks.createBackgroundTask({
        title,
        goal: refreshing(question, previous ?? null),
        origin: "chat",
        botId: bot?.id,
        conversationId,
        message: messageId,
        taintedBy: chatTaint(tainted?.()),
        request: ownerSaid?.(),
        research: true,
      });
      if (!task) return "The research couldn't start.";
      return `Started research task #${task.id}. It runs in the background for a few minutes; the owner sees its progress and answer under this reply. Don't wait for it.`;
    },
  }),
  def({
    name: "ask_bot",
    description:
      "Hand something to another of the owner's bots, for work in its line: it does it as its own task, with its own role, memory folder and plugins. Its progress shows under your reply, and you're told how it ended at the start of a later turn; then tell the owner what came of it. It can't see this conversation, so give it everything it needs. Don't wait for it.",
    schema: AskBotInput,
    run: async (
      { bot: to, request },
      { tasks, messageId, tainted, ownerSaid, bot, conversationId },
    ) => {
      if (!tasks || !bot) return "Other bots aren't available.";
      const task = tasks.askBot({
        from: bot,
        to,
        request,
        conversationId,
        message: messageId,
        taintedBy: chatTaint(tainted?.()) || null,
        ownerSaid: ownerSaid?.(),
      });
      if (typeof task === "string") return task;
      return `Asked ${tasks.d.bots.nameOf(task.botId)}: task #${task.id}. The owner sees its progress under this reply.`;
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
    run: async ({ name, prompt, cron, at }, { schedules, scheduleCard, tainted, bot }) => {
      if (!schedules) return "Schedules aren't available.";
      if (Boolean(cron) === Boolean(at)) return "Give either cron or at.";
      const s = schedules.create(
        { name, prompt, cron, at, botId: bot?.id ?? HATBOT_ID },
        "chat",
        tainted?.() ?? null,
      );
      scheduleCard?.(s);
      return `Created schedule ${scheduleLine(s)}`;
    },
  }),
  def({
    name: "schedule_list",
    description: "List every schedule with its timing, next run and what it does.",
    schema: z.object({}),
    run: async (_, { schedules, bot, bots }) =>
      schedules
        ?.list()
        .map((s) => scheduleLine(s) + whose(s.botId, bot, bots))
        .join("\n") || "No schedules.",
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
    run: async ({ id, ...patch }, ctx, signal) => {
      const { schedules, tainted } = ctx;
      if (patch.cron && patch.at) return "Give either cron or at, not both.";
      const current = schedules?.get(id);
      if (!schedules || !current) return `No schedule #${id}.`;
      const update = () => {
        const s = schedules.update(id, patch, { via: "chat", taintedBy: tainted?.() ?? null });
        return s ? `Updated schedule ${scheduleLine(s)}` : `No schedule #${id}.`;
      };
      if (patch.enabled !== false || !current.enabled) return update();
      return approved(
        ctx,
        signal,
        {
          name: "schedule_update",
          input: { id, ...patch },
          what: `Switch off the schedule #${id} "${current.name}"`,
        },
        update,
      );
    },
  }),
  def({
    name: "schedule_delete",
    description: "Delete a schedule. Its past runs stay in the Tasks list.",
    schema: z.object({ id: z.number().int() }),
    run: async ({ id }, ctx, signal) => {
      const s = ctx.schedules?.get(id);
      if (!ctx.schedules || !s) return `No schedule #${id}.`;
      return approved(
        ctx,
        signal,
        { name: "schedule_delete", input: { id }, what: `Delete the schedule #${id} "${s.name}"` },
        () => (ctx.schedules?.delete(id) ? `Deleted schedule #${id}.` : `No schedule #${id}.`),
      );
    },
  }),
  def({
    name: "watch_create",
    description:
      "Watch a web page or a plugin's read tool and act only when its value changes the way the owner wants: back in stock, a price below a number, a PR merged, a new release. It's checked on a timer without a model, so it costs nothing until something happens; prefer it to a schedule for \"tell me when…\". Pages are fetched from the desktop as plain HTML without running their scripts; set render for a page that fills in with JavaScript. Neither gets past bot protection (a challenge page, a captcha). Pick one value out with selector, path or pattern: a whole page changes too often. It looks once before it's made and tells you what it saw, or why it couldn't, so you can fix the selector or pattern.",
    schema: z.object({
      name: z.string().min(1).max(80).describe('Short name, e.g. "Framework 16 price"'),
      url: z.string().optional().describe("A page or JSON API to fetch"),
      tool: z.string().optional().describe("Or a plugin's read tool to call, e.g. forgejo_pull"),
      tool_input: z.record(z.string(), z.unknown()).optional().describe("The tool's input"),
      ...watchFields,
    }),
    run: async (input, { watchers, tainted, bot }) => {
      if (!watchers) return "Watchers aren't available.";
      if (Boolean(input.url) === Boolean(input.tool)) return "Give either url or tool.";
      const condition = conditionOf(input);
      if (typeof condition === "string") return condition;
      const source: WatchSource = {
        kind: input.url ? "page" : "tool",
        ...(input.url
          ? { url: input.url, ...(input.render ? { render: true } : {}) }
          : { tool: input.tool, input: input.tool_input ?? {} }),
        ...(input.selector ? { selector: input.selector } : {}),
        ...(input.path ? { path: input.path } : {}),
        ...(input.pattern ? { pattern: input.pattern } : {}),
      };
      try {
        const w = await watchers.create(
          {
            name: input.name,
            source,
            condition,
            prompt: input.prompt?.trim() ?? "",
            everyMinutes: Math.max(minWatchMinutes(source), input.every_minutes ?? 60),
            once: input.once ?? false,
            enabled: true,
            botId: bot?.id ?? HATBOT_ID,
          },
          "chat",
          tainted?.() ?? null,
        );
        return `Created watcher ${watcherLine(w)}`;
      } catch (err) {
        if (err instanceof WatchError) return `Not created: ${err.message}`;
        throw err;
      }
    },
  }),
  def({
    name: "watch_list",
    description: "List every watcher with what it looks at, what it saw last, and what it does.",
    schema: z.object({}),
    run: async (_, { watchers, bot, bots }) =>
      watchers
        ?.list()
        .map((w) => watcherLine(w) + whose(w.botId, bot, bots))
        .join("\n") || "No watchers.",
  }),
  def({
    name: "watch_update",
    description:
      "Change a watcher: what counts, how often it looks, whether it runs the page's scripts, what it does, its name, or turn it on or off. Only the fields you give change.",
    schema: z.object({
      id: z.number().int(),
      name: z.string().min(1).max(80).optional(),
      enabled: z.boolean().optional(),
      ...watchFields,
    }),
    run: async ({ id, ...input }, ctx, signal) => {
      const { watchers, tainted } = ctx;
      const w = watchers?.get(id);
      if (!watchers || !w) return `No watcher #${id}.`;
      const condition = input.when ? conditionOf(input) : undefined;
      if (typeof condition === "string") return condition;
      if (input.render !== undefined && w.source.kind !== "page")
        return "Only a page has scripts to run; this watcher calls a tool.";
      const picks = ["selector", "path", "pattern"] as const;
      const source: WatchSource | undefined =
        picks.some((k) => input[k] !== undefined) || input.render !== undefined
          ? {
              ...w.source,
              // An empty string takes that pick away.
              ...Object.fromEntries(
                picks.filter((k) => input[k] !== undefined).map((k) => [k, input[k] || undefined]),
              ),
              ...(input.render !== undefined ? { render: input.render || undefined } : {}),
            }
          : undefined;
      // Running the page's scripts looks less often, so a shorter time is raised to that.
      const min = minWatchMinutes(source ?? w.source);
      const every = input.every_minutes ?? (w.everyMinutes < min ? min : undefined);
      const update = async () => {
        try {
          const updated = await watchers.update(
            id,
            {
              name: input.name,
              enabled: input.enabled,
              condition,
              prompt: input.prompt?.trim(),
              everyMinutes: every === undefined ? undefined : Math.max(min, every),
              once: input.once,
              source,
            },
            { via: "chat", taintedBy: tainted?.() ?? null },
          );
          return updated ? `Updated watcher ${watcherLine(updated)}` : `No watcher #${id}.`;
        } catch (err) {
          if (err instanceof WatchError) return `Not changed: ${err.message}`;
          throw err;
        }
      };
      if (input.enabled !== false || !w.enabled) return update();
      return approved(
        ctx,
        signal,
        {
          name: "watch_update",
          input: { id, ...input },
          what: `Switch off the watcher #${id} "${w.name}"`,
        },
        update,
      );
    },
  }),
  def({
    name: "watch_delete",
    description: "Delete a watcher. The tasks it started stay in the Tasks list.",
    schema: z.object({ id: z.number().int() }),
    run: async ({ id }, ctx, signal) => {
      const w = ctx.watchers?.get(id);
      if (!ctx.watchers || !w) return `No watcher #${id}.`;
      return approved(
        ctx,
        signal,
        { name: "watch_delete", input: { id }, what: `Delete the watcher #${id} "${w.name}"` },
        () => (ctx.watchers?.delete(id) ? `Deleted watcher #${id}.` : `No watcher #${id}.`),
      );
    },
  }),
  def({
    name: "trigger_list",
    description:
      "List the webhooks and Uptime Kuma alert hooks that start background tasks, with what each run does. The owner creates them in Schedules & Triggers.",
    schema: z.object({}),
    run: async (_, { triggers, bot, bots }) =>
      triggers
        ?.list()
        .map(
          (t) =>
            `#${t.id} "${t.name}" (${t.kind === "kuma" ? "Uptime Kuma" : "webhook"}${t.trusted ? ", trusted" : ""}${t.enabled ? "" : ", off"}${t.confirmChecks ? `, waits for ${t.confirmChecks} more failed check${t.confirmChecks > 1 ? "s" : ""}` : ""})${t.lastFiredAt ? `; last event ${local(t.lastFiredAt)}` : ""}\n  Does: ${t.prompt}${whose(t.botId, bot, bots)}`,
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
    run: async ({ id, ...patch }, ctx, signal) => {
      const { triggers, tainted } = ctx;
      // A trigger's runs trust its instructions; untrusted content mustn't get to write them.
      if (patch.prompt !== undefined && tainted?.())
        return "Not changed: this conversation has read untrusted content, so it can't rewrite what a trigger does. Ask the owner to change it in Schedules & Triggers.";
      const current = triggers?.get(id);
      if (!triggers || !current) return `No trigger #${id}.`;
      const update = () => {
        const t = triggers.update(id, patch);
        return t ? `Updated trigger #${t.id} "${t.name}".` : `No trigger #${id}.`;
      };
      const off = patch.enabled === false && current.enabled;
      const checks =
        patch.confirmChecks !== undefined && patch.confirmChecks !== current.confirmChecks;
      if (!off && !checks) return update();
      const waits = (n: number) =>
        n ? `wait for ${n} more failed check${n > 1 ? "s" : ""}` : "act on a down alert at once";
      const what = [
        ...(off ? ["switch it off"] : []),
        ...(checks ? [waits(patch.confirmChecks ?? 0)] : []),
      ].join(", and ");
      return approved(
        ctx,
        signal,
        {
          name: "trigger_update",
          input: { id, ...patch },
          what: `Change the trigger #${id} "${current.name}": ${what}`,
        },
        update,
      );
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
    const offered = ctx.pluginTools ?? ctx.plugins?.tools() ?? [];
    const plugin = offered.find((t) => t.name === name);
    if (plugin?.access === "write") {
      if (!ctx.gated) return { content: `${name} can't run here.`, isError: true };
      return ctx.gated(plugin, input, signal);
    }
    if (plugin) {
      const r = await runPluginTool(plugin, input, { task: null, signal });
      if (r.untrusted) ctx.taint?.(describeCall(plugin, input));
      return r;
    }
    const names = [...TOOLS, ...offered].map((t) => t.name);
    return { content: `Unknown tool "${name}". Available: ${names.join(", ")}`, isError: true };
  }
  const parsed = tool.schema.safeParse(input);
  if (!parsed.success)
    return { content: `Invalid input: ${z.prettifyError(parsed.error)}`, isError: true };
  try {
    // biome-ignore lint/suspicious/noExplicitAny: each tool's run matches its own schema
    return { content: await tool.run(parsed.data as any, ctx, signal), isError: false };
  } catch (err) {
    if (
      err instanceof MemoryError ||
      err instanceof ScheduleError ||
      err instanceof DesktopError ||
      err instanceof NotChanged
    )
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
  "watch_list",
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
  "investigate",
  "finish_research",
  "report_findings",
  "confirm_intent",
  "request_takeover",
  "record_conversation",
  ...NEGOTIATE_TOOL_NAMES,
];

/** The code the API runs for the web tools' dynamic filtering, by its server tool names. */
const CODE_TOOLS = ["code_execution", "bash_code_execution"];

/**
 * Anthropic's web search and fetch, run by the API itself (PLAN.md §5.5), in the versions with dynamic
 * filtering. The model calls them directly for a quick look, or from code it runs in a container of
 * Anthropic's, so that only what matters of the results and pages reaches it. A call made from code
 * stays out of the response, with what it read; the code's output is what the model sees. Fetch only
 * takes URLs already in the conversation. Searches are local to the brain's time zone, which is the
 * owner's. HATBOT_WEB_TOOLS=basic brings back the versions without filtering, should the API refuse
 * these.
 */
export function webTools(opts: {
  /** The most of a page a direct fetch reads. */
  pageTokens: number;
  /** Searches and fetches each request may make. */
  uses?: number;
  /** A fetched page can be cited, as search results always can. */
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

/** A task's: it reads more of a page than the chat, where a page stays for every later reply. */
export const WEB_TOOLS = webTools({ pageTokens: 30000 });
export const CHAT_WEB_TOOLS = webTools({ pageTokens: 10000, citations: true });

/** A search ("" when the code doesn't say what for) or a page read ("" when it doesn't say which). */
export type WebCall = { search: string } | { read: string };

const STRING = String.raw`[fFrRuU]?(["'])((?:\\.|(?!\1).)*)\1`;
const QUERY = new RegExp(String.raw`(?:["']query["']\s*:|\bquery\s*=)\s*${STRING}`, "g");
const URL_IN_CODE = /https?:\/\/[^\s"'`\\<>)\]}]+/g;
const MAX_CALLS = 10;

/**
 * The web searches and reads in a server tool call: one made directly, or the ones in code the model
 * ran for dynamic filtering, from the queries and URLs written in it.
 */
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

/**
 * What a reply looked up on the web, in a line each: `Searched the web for "x"`, `Read https://…`.
 * Code whose own calls came back with it (a paused turn's) is told by those.
 */
export function webReads(content: Anthropic.Beta.BetaContentBlock[]): string[] {
  const told = new Set(
    content.flatMap((b) =>
      b.type === "server_tool_use" && b.caller && "tool_id" in b.caller ? [b.caller.tool_id] : [],
    ),
  );
  return content.flatMap((b) =>
    b.type === "server_tool_use" && !told.has(b.id) ? webCalls(b.name, b.input).map(readLine) : [],
  );
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
 * The container the API ran the model's code in, to send with the next request of the same reply or
 * task: code paused mid-run carries on in it, and what the code kept stays.
 */
/**
 * The web pages a response cites, adding them to `cited` in the order it first cites them. A fetched
 * page's citations name its title, not its URL: `pages` maps the titles of what was fetched so far.
 */
export function addSources(
  cited: Source[],
  pages: Map<string, string>,
  content: Anthropic.Beta.BetaContentBlock[],
): void {
  for (const b of content)
    if (b.type === "web_fetch_tool_result" && b.content.type === "web_fetch_result")
      pages.set(b.content.content.title || b.content.url, b.content.url);
  for (const b of content) {
    if (b.type !== "text") continue;
    for (const c of b.citations ?? []) {
      const source =
        c.type === "web_search_result_location"
          ? { url: c.url, title: c.title || c.url }
          : "document_title" in c && c.document_title && pages.has(c.document_title)
            ? { url: pages.get(c.document_title) as string, title: c.document_title }
            : null;
      if (source && /^https?:\/\//.test(source.url) && !cited.some((s) => s.url === source.url))
        cited.push(source);
    }
  }
}

export const containerOf = (res: Anthropic.Beta.BetaMessage, before?: string) =>
  res.container?.id ?? before;
