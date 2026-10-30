// Research: a background task that plans a question, hands its parts to helpers that search at once,
// checks what it cites against what the pages said, and ends in a saved, cited report.
import {
  definePlugin,
  hosts,
  invalidInput,
  ready,
  type TaskRunner,
  tool,
} from "@hatbot/plugin-sdk";
import { z } from "zod";
import { earlierReport, RESEARCH_EFFORT, refreshing } from "./goal";
import { RESEARCH_ASK_BOT } from "./prompts";
import {
  type Deps,
  FinishResearch,
  finishResearch,
  investigate,
  keepAfterRestart,
  keepUnfinished,
  LEAD_WEB_TOOLS,
  MAX_RESEARCH_STEPS,
  NEEDS,
  RESEARCH_BETA,
  RESEARCH_LOOP_TOOLS,
  RESEARCH_TOKENS,
  RESEARCH_TOOLS,
  type ResearchRun,
  ResearchState,
  refusedLinks,
  researchPrompt,
} from "./research";

export { RESEARCH_CHECK_PROMPT, RESEARCH_PROMPT, RESEARCH_WORKER_PROMPT } from "./prompts";
export { plain, quoteFound } from "./research";

const ResearchInput = z.object({
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

export const researchPlugin = definePlugin({
  id: "research",
  name: "Research",
  description:
    "Research tasks: many searches and pages at once, what the report says checked against its sources, and a cited report saved in memory.",
  config: z.object({}),
  defaultOn: true,
  allBots: true,
  needs: NEEDS,
  start: (ctx) => {
    const d: Deps = {
      ...hosts(ctx, NEEDS),
      db: ctx.db,
      attachments: ctx.files?.attachments,
      clock: ctx.clock,
    };
    return ready([researchTool(d)], {
      runners: { research: researchRunner(d) },
      prompt: { chat: CHAT_LINE },
    });
  },
});

const CHAT_LINE = `- For a question that needs many searches and pages (comparing products or options, prices across shops, a technical question whose sources disagree), start research instead of searching yourself. If the question leaves out something that would change the answer (the budget, where the owner is, what it's for), ask first with ask_owner: at most three short questions. When you start it, say your plan in a line. Its report is saved in memory under research/, in your own notes folder if you have one; to bring a report up to date, pass its path as previous.`;

const researchTool = (d: Deps) =>
  tool({
    name: "research",
    description:
      "Start a research task, for a question that needs many searches and pages: comparing products or options, prices across shops, a technical question whose sources disagree. It plans the question and hands parts to helpers that search at once, what it cites is checked against the quotes the helpers copied from the pages, and it ends in a report with numbered sources, saved in memory and attached. It takes a few minutes and costs more than a task, usually under $1. Its short answer shows under your reply. It can't see this conversation, so put everything that bears on the question in it. For a fact or two, search yourself instead.",
    schema: ResearchInput,
    access: "own",
    places: ["chat"],
    whole: true,
    label: "Starting research",
    run: async ({ title, question, previous }, call) => {
      if (previous && !(await d.memory.exists(previous)))
        return `There's no report at ${previous}. Check the path, or leave previous out.`;
      const by = call.tainted?.();
      const task = d.tasks.createBackgroundTask({
        title,
        goal: refreshing(question, previous ?? null),
        origin: "chat",
        botId: call.bot?.id,
        conversationId: call.conversationId,
        message: call.messageId,
        taintedBy: by && `The chat had read: ${by}`,
        request: call.ownerSaid?.(),
        askedIn: call.answering,
        runner: "research",
      });
      if (!task) return "The research couldn't start.";
      return `Started research task #${task.id}. It runs in the background for a few minutes; the owner sees its progress and answer under this reply. Don't wait for it.`;
    },
  });

const researchRunner = (d: Deps): TaskRunner => ({
  // Research only reads and writes up, so it gets the plugins' lookups and no tool that changes anything.
  place: "research",
  onlyLooks: "research only looks things up",
  role: "small",
  effort: RESEARCH_EFFORT,
  // It writes its whole report into one call.
  maxTokens: 64000,
  maxSteps: MAX_RESEARCH_STEPS,
  budgetUsd: () => d.settings.get().limits.researchUsd,
  betas: [RESEARCH_BETA],
  // It paces itself to this many tokens, its helpers' apart.
  taskBudget: RESEARCH_TOKENS,
  webTools: LEAD_WEB_TOOLS,
  loopTools: RESEARCH_LOOP_TOOLS,
  tools: RESEARCH_TOOLS,
  prompt: researchPrompt,
  handOver: RESEARCH_ASK_BOT,
  nudge: {
    text: "End the research with finish_research, with the answer and the report.",
    stopped: "Stopped: it ended without calling finish_research.",
  },
  reports: true,
  rerunGoal: (t, goal) => refreshing(goal, t.reportPath ?? earlierReport(t.goal)),
  // A report already saved is kept; otherwise what it had is read back from its turns.
  restarted: async (task, why) => (task.reportPath ? why : keepAfterRestart(d, task, why)),
  start: (r) => {
    const run: ResearchRun = { d, ...r };
    const found = new ResearchState();
    let toldToFinish = false;
    // A second finish_research in one turn would skip the check the first one got.
    let finishedIn = -1;
    return {
      refuse: (text, who) => refusedLinks(run, found.sources, text, who),
      call: async (name, input, c) => {
        if (name === "investigate") return investigate(run, found.sources, input);
        if (finishedIn === c.step)
          return { content: "Not run: call finish_research once a turn.", isError: true };
        finishedIn = c.step;
        const p = FinishResearch.safeParse(input);
        if (!p.success) return { content: invalidInput(p.error), isError: true };
        const broken = await c.checkCharts(`${p.data.answer}\n\n${p.data.report}`);
        if (broken)
          return {
            content: `Not finished: ${broken} Call finish_research again with it fixed. Don't guess where a value belongs; if you can't tell, leave the chart out.`,
            isError: true,
          };
        const res = await finishResearch(run, found, p.data);
        if ("retry" in res) return { content: res.retry, isError: true };
        return { finish: { outcome: p.data.outcome, summary: res.summary, notify: p.data.notify } };
      },
      // Near its step cap or its limit, it finishes with what it has rather than stopping short.
      after: ({ stepsLeft, spentUsd, limitUsd }) => {
        if (toldToFinish) return null;
        // Room for two more requests at most: the report, and one more if the check sends it back.
        if (stepsLeft > 2 && spentUsd < 0.8 * limitUsd && limitUsd - spentUsd >= 2 * r.reserveUsd())
          return null;
        toldToFinish = true;
        const near =
          stepsLeft <= 2
            ? `its step limit (${stepsLeft} steps left)`
            : `its spending limit ($${spentUsd.toFixed(2)} of $${limitUsd})`;
        return `This task is near ${near}. Call finish_research now with what you have, and say in the report what's left open.`;
      },
      unfinished: (summary) => keepUnfinished(run, found, summary),
    };
  },
});
