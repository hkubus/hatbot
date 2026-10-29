// A kind of background task a plugin gives: the core runs its loop (spend, approvals, the untrusted
// rule, steering), and the runner shapes it with its prompt, its own tools and how it ends.
import type { Bot, Task } from "@hatbot/shared";
import type { CallContext, Place } from "./index";
import type { CreateParams, ModelMessageParam, ModelRole, ModelTool } from "./models";

/** How hard the model thinks, as the API takes it. */
export type Effort = NonNullable<NonNullable<CreateParams["output_config"]>["effort"]>;

export type TaskRunner = {
  /** Which plugin tools it's offered: "research" gives lookups only. */
  place: Place;
  /** Set when only lookups may run in it: why, e.g. "research only looks things up". */
  onlyLooks?: string;
  /** The model its tasks use, by its role in Settings. */
  role: ModelRole;
  effort: Effort;
  maxTokens: number;
  maxSteps: number;
  /** Its starting spend limit, and what each raise adds; a task's when left out. */
  budgetUsd?: () => number;
  /** Beta headers its requests add, and the API's task budget in tokens. */
  betas?: string[];
  taskBudget?: number;
  /** The web tools it gets, in place of a task's. */
  webTools?: ModelTool[];
  /** The loop's own tools it keeps (ask_bot, ask_owner, run_desktop_task, wait…); all when left out. */
  loopTools?: string[];
  /** Its own tools, answered by its `call`; their results are never cleared. */
  tools: ModelTool[];
  prompt: (bot: Bot) => string;
  /** In place of the line about handing work to other bots. */
  handOver?: string;
  /** Said when a reply calls no tool; after a second such reply it stops, failed, with `stopped`. */
  nudge: { text: string; stopped: string };
  /** It ends in a report, attached, which the apps show. */
  reports?: boolean;
  /** Its goal when the owner runs it again, from what it was and what they changed it to. */
  rerunGoal?: (task: Task, goal: string) => string;
  start: (run: RunnerRun) => RunnerState;
  /** A run a restart stopped: the summary to end it with. */
  restarted?: (task: Task, why: string) => Promise<string>;
};

export type RunnerRun = {
  task: Task;
  signal: AbortSignal;
  /** Marks the task as having read untrusted content. */
  taint: (source: string) => void;
  /** Its conversation so far. */
  messages: readonly ModelMessageParam[];
  /** What its next request may cost: work it starts meanwhile leaves room for it. */
  reserveUsd: () => number;
};

export type RunnerCall = {
  /** The first time it's asked: what's wrong with the charts in `text`, or ""; after that, "". */
  checkCharts: (text: string) => Promise<string>;
  /** The loop's step: calls made in one turn share it. */
  step: number;
};

export type RunnerResult =
  | { content: string; isError?: boolean }
  | { finish: { outcome: "done" | "failed"; summary: string; notify: boolean } };

export type RunnerState = {
  call: (name: string, input: unknown, c: RunnerCall) => Promise<RunnerResult>;
  /** Work it would hand out (to a desktop task, another bot): why that's refused, or null. */
  refuse?: (text: string, who: string) => string | null;
  /** After each step's calls: something to tell it, such as to finish now. */
  after?: (s: { stepsLeft: number; spentUsd: number; limitUsd: number }) => string | null;
  /** It stopped short, and wasn't cancelled: the summary to end with. */
  unfinished?: (summary: string) => Promise<string>;
};

/** Ends a job's task short, as cancelled or failed, with `summary`. */
export class JobStop extends Error {
  constructor(
    readonly status: "failed" | "cancelled",
    readonly summary: string,
  ) {
    super(summary);
  }
}

/** A kind of background task a plugin runs itself, start to end, without the model's loop. */
export type TaskJob = {
  /** Said to a bot that tries to steer task `id`. */
  unsteerable: (id: number) => string;
  /** Its summary when it's done; a PluginError fails it with its message, a JobStop as it says. */
  run: (job: JobRun) => Promise<string>;
};

export type JobRun = {
  task: Task;
  /** What it was started with, as `job` in the task. */
  input: unknown;
  signal: AbortSignal;
  /** What untrusted content it read, or null. */
  tainted: () => string | null;
  taint: (by: string) => void;
  /** Asks as a tool's write does: the review, then the owner. */
  approve: NonNullable<CallContext["approve"]>;
  /** A line of what it's doing, shown on its page. */
  progress: (line: string) => void;
  /** The reply it shows under, in the chat that started it. */
  reply: () => number | null;
};
