// ask_helpers: parts of a job handed to small-model helpers that look things up at once, each with
// the bot's lookups and the web and nothing that changes anything, so the detail stays out of the
// caller's context.
import type Anthropic from "@anthropic-ai/sdk";
import {
  BudgetError,
  type CallContext,
  containerOf,
  cutOff,
  estimateTokens,
  fixedTokens,
  invalidInput,
  localStamp,
  modelErrorText,
  type PluginTool,
  serverToolWaiting,
  tagJson,
  toolParam,
  untrustedBlock,
  webReads,
  webTools,
} from "@hatbot/plugin-sdk";
import type { Bot } from "@hatbot/shared";
import { z } from "zod";
import { describeCall, offered, runPluginTool } from "../plugins/registry";
import { requestCeiling } from "../spend";
import type { Tasks } from "../tasks/service";
import { HELPER_PROMPT } from "./prompt";
import { imageBlocks, liveTool } from "./tools";
import { tagText } from "./untrusted";

export const MAX_HELPERS = 5;
const MAX_STEPS = 12;
const MAX_TOKENS = 16000;
/** Searches and fetches each request may make, and the most of a page a helper reads. */
const WEB_USES = 5;
const PAGE_TOKENS = 10_000;
const SEARCH_RESULT_TOKENS = 3_000;
const ONLY_LOOKS = "helpers only look things up";

const Part = z.object({
  topic: z.string().min(1).max(80).describe('A few words, e.g. "updates on web01"'),
  brief: z
    .string()
    .min(1)
    .max(3000)
    .describe(
      "What to find out and report, and every detail it needs (hosts, names, what you already know): the helper can't see this conversation or the other parts",
    ),
});
export const AskHelpersInput = z.object({ parts: z.array(Part).min(1).max(MAX_HELPERS) });
type Part = z.infer<typeof Part>;

const Report = z.object({
  found: z
    .string()
    .min(1)
    .max(6000)
    .describe("What you found, with the values that matter exactly as the tools gave them"),
  gaps: z
    .string()
    .max(1500)
    .describe("What you couldn't check or find out, and why; empty if there's nothing"),
});

const REPORT_TOOL = toolParam({
  name: "report",
  description: "Report what you found and end your part. Call it once.",
  schema: Report,
});
const REPORT_NOW: Anthropic.Beta.BetaToolChoiceTool = { type: "tool", name: "report" };

const LINK = /https?:\/\/\S+/i;
/** A link without its scheme: a host and a path or query, which can carry data out. */
const BARE_LINK = /(?<![\w@.-])(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?[/?]\S+/i;

export type HelperCall = {
  tasks: Tasks;
  bot: Bot;
  signal: AbortSignal;
  taskId?: number;
  episodeId?: number;
  conversationId?: number;
  tainted: () => string | null;
  taint: (by: string) => void;
};

type Ran = { topic: string; found: string; gaps: string; note?: string; untrusted: string[] };

/** The bot's lookups: what a research task gets, which never changes anything. */
function lookupsOf(c: HelperCall): PluginTool[] {
  const { d } = c.tasks;
  const others = d.bots.list().filter((b) => b.id !== c.bot.id);
  const offer = { place: "research", bot: c.bot, others, incognito: false } as const;
  return d.plugins
    .tools(c.bot.plugins, d.bots.leftToOthers(c.bot))
    .filter((t) => t.access === "read" && offered(t, offer));
}

export async function askHelpers(
  c: HelperCall,
  input: z.infer<typeof AskHelpersInput>,
): Promise<string> {
  // A helper may fetch any link its brief names, which web_fetch would refuse the caller: one written
  // from what the caller read could carry it out.
  if (c.tainted()) {
    const linked = input.parts.find((p) => LINK.test(p.brief) || BARE_LINK.test(p.brief));
    if (linked)
      return `Not started: this has read untrusted content, so a brief can't hold links ("${linked.topic}" does). Name the site or what to search for instead.`;
  }
  const tools = lookupsOf(c);
  for (const p of input.parts) step(c, "ask_helpers", `Asked a helper: ${p.topic}`);
  const ran = await Promise.all(
    input.parts.map((p) =>
      runHelper(c, p, tools).catch((err): Ran => {
        if (c.signal.aborted) throw err;
        console.error("a helper failed", err);
        return {
          topic: p.topic,
          found: "",
          gaps: "",
          note: `The helper failed (${modelErrorText(err)}).`,
          untrusted: [],
        };
      }),
    ),
  );
  const read = ran.flatMap((r) => r.untrusted);
  for (const by of new Set(read)) c.taint(by);
  // What started it may have been steered too: its briefs carry that, and so do the reports.
  const untrusted = read.length > 0 || c.tainted() !== null;
  return ran
    .map((r) => {
      const text = [r.found, r.gaps && `Couldn't check: ${r.gaps}`, r.note]
        .filter(Boolean)
        .join("\n\n");
      return untrusted
        ? untrustedBlock("helper_report", text || "Nothing found.", { topic: r.topic })
        : `<helper_report topic=${tagJson(r.topic)}>\n${tagText(text || "Nothing found.")}\n</helper_report>`;
    })
    .join("\n\n");
}

function step(c: HelperCall, name: string, detail: string) {
  if (c.taskId !== undefined)
    c.tasks.addStep(c.taskId, { kind: "action", name, detail, url: null });
}

/** One helper: the small model with the lookups, until it reports or runs out of steps or money. */
async function runHelper(c: HelperCall, part: Part, offeredTools: PluginTool[]): Promise<Ran> {
  const { d } = c.tasks;
  const model = d.settings.get().smallModel;
  const untrusted: string[] = [];
  const stopped = (note: string): Ran => ({
    topic: part.topic,
    found: "",
    gaps: "",
    note,
    untrusted,
  });
  const tools: Anthropic.Beta.BetaToolUnion[] = [
    ...offeredTools.map(toolParam),
    REPORT_TOOL,
    ...webTools({ pageTokens: PAGE_TOKENS, uses: WEB_USES }),
  ];
  const system = [
    { type: "text" as const, text: HELPER_PROMPT, cache_control: { type: "ephemeral" as const } },
  ];
  const messages: Anthropic.Beta.BetaMessageParam[] = [
    {
      role: "user",
      content: `<brief>\n${tagText(part.brief)}\n</brief>\n\nIt's ${localStamp(new Date(c.tasks.clock()))}, the owner's local time.`,
    },
  ];
  const cc: CallContext = {
    task: c.taskId !== undefined ? { id: c.taskId, tainted: c.tainted() !== null } : null,
    signal: c.signal,
    bot: c.bot,
    conversationId: c.conversationId,
    episodeId: c.episodeId,
    tainted: c.tainted,
    taint: (by) => untrusted.push(by),
  };
  const limit =
    c.taskId !== undefined ? { id: c.taskId, limitUsd: c.tasks.budget(c.taskId) } : undefined;
  let container: string | undefined;
  let paused = false;
  let mustReport = false;
  // Two more than the cap, for paused turns to finish before the last, forced one.
  for (let n = 0; n < MAX_STEPS + 2; n++) {
    if (c.signal.aborted) throw c.signal.reason;
    const cost = requestCeiling(model, {
      prompt:
        estimateTokens(messages) +
        fixedTokens(system, tools) +
        WEB_USES * (PAGE_TOKENS + SEARCH_RESULT_TOKENS),
      write: "5m",
      maxTokens: MAX_TOKENS,
      webSearches: WEB_USES,
    });
    let release: () => void;
    try {
      release = d.spend.hold(cost, limit);
    } catch (err) {
      if (err instanceof BudgetError) return stopped(`Stopped: ${err.message}`);
      throw err;
    }
    const force = !paused && (mustReport || n >= MAX_STEPS - 1);
    const record = (m: string, usage: Parameters<typeof d.spend.recordResponse>[0]["usage"]) =>
      d.spend.recordResponse({
        model: m,
        purpose: "helpers",
        usage,
        taskId: c.taskId,
        episodeId: c.episodeId,
        botId: c.bot.id,
      });
    let res: Anthropic.Beta.BetaMessage;
    try {
      res = await d.model.stream(
        {
          model,
          max_tokens: MAX_TOKENS,
          system,
          cache_control: { type: "ephemeral" },
          tools,
          ...(force ? { tool_choice: REPORT_NOW } : {}),
          thinking: { type: "adaptive" },
          output_config: { effort: "medium" },
          // Pages and tool output read early are cleared once the prompt passes 40k, below the 100k
          // where Haiku 5.5 bills the whole request at 5x.
          betas: ["context-management-2025-06-27"],
          context_management: {
            edits: [
              {
                type: "clear_tool_uses_20250919",
                trigger: { type: "input_tokens", value: 40_000 },
                keep: { type: "tool_uses", value: 3 },
                clear_at_least: { type: "input_tokens", value: 10_000 },
                exclude_tools: ["report"],
              },
            ],
          },
          ...(container ? { container } : {}),
          messages,
        },
        { signal: c.signal, onFailedUsage: record },
      );
    } finally {
      release();
    }
    record(model, res.usage);
    messages.push({
      role: "assistant",
      content: res.content as Anthropic.Beta.BetaContentBlockParam[],
    });
    container = containerOf(res, container);
    for (const read of webReads(res.content)) {
      step(c, "web", `${part.topic}: ${read}`);
      untrusted.push(read);
    }
    paused = res.stop_reason === "pause_turn";
    if (paused) continue;
    if (res.stop_reason === "refusal") return stopped("The helper declined this part.");
    const calls = res.content.filter(
      (b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use",
    );
    const report = calls.find((b) => b.name === "report");
    const parsed = report && !cutOff(res) ? Report.safeParse(report.input) : undefined;
    if (parsed?.success)
      return { topic: part.topic, found: parsed.data.found, gaps: parsed.data.gaps, untrusted };
    if (cutOff(res)) mustReport = true;
    const results = await Promise.all(
      calls.map(async (call): Promise<Anthropic.Beta.BetaContentBlockParam> => {
        const error = (content: string) =>
          ({ type: "tool_result", tool_use_id: call.id, content, is_error: true }) as const;
        if (cutOff(res)) return error("Cut off at max_tokens. Report what you have, shorter.");
        if (call === report)
          return error(parsed && !parsed.success ? invalidInput(parsed.error) : "Not reported.");
        if (call.name === "report") return error("Call report once.");
        const found = offeredTools.find((t) => t.name === call.name);
        if (!found) return error(`Unknown tool "${call.name}".`);
        const now = c.tasks.d.bots.get(c.bot.id) ?? c.bot;
        const t = liveTool(
          found,
          c.tasks.d.plugins.tools(now.plugins, c.tasks.d.bots.leftToOthers(now)),
          {
            bot: c.bot.name,
            since: "since the helper started",
            onlyLooks: ONLY_LOOKS,
          },
        );
        if (typeof t === "string") return error(t);
        const what = describeCall(t, call.input);
        step(c, t.name, `${part.topic}: ${what}`);
        const r = await runPluginTool(t, call.input, cc);
        if (r.untrusted) untrusted.push(what);
        return {
          type: "tool_result",
          tool_use_id: call.id,
          content: r.images?.length
            ? [{ type: "text", text: r.content }, ...imageBlocks(r.images)]
            : r.content,
          ...(r.isError ? { is_error: true } : {}),
        };
      }),
    );
    const nudge =
      n >= MAX_STEPS - 2 || !calls.length ? "Report what you found now, with report." : "";
    // Not while the web tools' code is still running: then only tool results may follow.
    const text =
      nudge && !serverToolWaiting(res.content) ? [{ type: "text" as const, text: nudge }] : [];
    if (results.length || text.length)
      messages.push({ role: "user", content: [...results, ...text] });
  }
  return stopped(`Stopped after ${MAX_STEPS} steps without reporting.`);
}
