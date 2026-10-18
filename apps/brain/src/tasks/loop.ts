// What desktop and background tasks' model loops share (PLAN.md §6.2, §6.3): each request held against
// the limits at the most it may cost, streamed with its progress shown and billed to the task; asking
// you; how a reply goes on or ends the run; and how a run that ended by throwing ends its task.
import type Anthropic from "@anthropic-ai/sdk";
import type { Task } from "@hatbot/shared";
import { cutOff, modelErrorText, type StreamParams } from "../agent/model";
import type { NewApproval, Outcome } from "../approvals";
import { DesktopError } from "../desktop/client";
import {
  BudgetError,
  estimateTokens,
  fixedTokens,
  requestCeiling,
  searchesIn,
  usesReserve,
} from "../spend";
import type { Tasks } from "./service";

/**
 * Ends the run from inside a helper. `notify` false: a routine result nobody needs to hear about.
 * `escalate`: a failure a stronger model might get past (out of steps or time, refused, cut off, or it
 * gave up), with the model's own account of what it tried when it gave one.
 */
export class Stop extends Error {
  constructor(
    readonly status: "done" | "failed" | "cancelled",
    readonly summary: string,
    readonly notify = true,
    readonly escalate: false | { account: string | null } = false,
  ) {
    super(summary);
  }
}

/** Models whose between-tool progress notes (`display: "updates"`) are documented. */
const UPDATES_MODELS = new Set(["claude-opus-5-5"]);

export const thinkingFor = (model: string) =>
  UPDATES_MODELS.has(model)
    ? ({ type: "adaptive", display: "updates" } as const)
    : ({ type: "adaptive" } as const);

type Params = Omit<StreamParams, "stream">;

/** A run's requests to the model, and what the last one left in the cache, whose entries last 5 minutes. */
export function requestsFor(tasks: Tasks, task: Task, signal: AbortSignal) {
  const { d } = tasks;
  const { id } = task;
  const r = {
    cache: { tokens: 0, at: 0 },
    /** Lets go of what the request in flight holds against the limits. */
    release: () => {},

    /**
     * The most a request may cost: images at their typical size, the part the last request left in
     * the cache at the read price, all of max_tokens, and every web search it may make.
     */
    ceiling(params: Params): number {
      const cached = tasks.clock() - r.cache.at < 5 * 60_000 ? r.cache.tokens : 0;
      const prompt = estimateTokens(params.messages) + fixedTokens(params.system, params.tools);
      return requestCeiling(params.model, {
        prompt: Math.max(prompt, cached),
        cached,
        write: "5m",
        maxTokens: params.max_tokens,
        webSearches: searchesIn(params.tools ?? []),
      });
    },

    /** Holds `usd` against the limits until it's let go of; past one, it throws BudgetError. */
    holdOnly: (usd: number) =>
      d.spend.hold(usd, { id, limitUsd: tasks.budget(id) }, { reserve: usesReserve(task.origin) }),

    /**
     * Holds the next request's most against the limits. At the task's limit it asks the owner for
     * more and returns false, for the request to be made again; past another limit it stops the run,
     * saying `overLimit` if given.
     */
    async hold(
      usd: number,
      ask: (input: { kind: "budget"; summary: string; reason: string }) => Promise<{
        outcome: Outcome;
      }>,
      overLimit?: (limit: "daily" | "monthly") => string,
    ): Promise<boolean> {
      try {
        r.release = r.holdOnly(usd);
        return true;
      } catch (err) {
        if (!(err instanceof BudgetError)) throw err;
        if (err.limit !== "task")
          throw new Stop("failed", overLimit?.(err.limit) ?? `Stopped: ${err.message}`);
        const extra = tasks.raiseStep(id);
        const { outcome } = await ask({ kind: "budget", ...tasks.budgetAsk(id, extra) });
        if (outcome !== "approved") throw new Stop("failed", "Stopped at its spending limit.");
        tasks.raiseBudget(id, extra);
        return false;
      }
    },

    /** Streams a request held with hold(), showing its progress, and bills it to the task. */
    async stream(params: Params): Promise<Anthropic.Beta.BetaMessage> {
      const sent = tasks.clock();
      const progress = (text: string) => d.events.emit({ type: "task.progress", taskId: id, text });
      const res = await d.model
        .stream(params, {
          onText: progress,
          onThinking: progress,
          onFailedUsage: (model, usage) =>
            d.spend.recordResponse({ model, purpose: "task", usage, taskId: id }),
          signal,
        })
        .finally(r.release);
      const { usage } = res;
      r.cache = {
        tokens: (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
        at: sent,
      };
      d.spend.recordResponse({ model: params.model, purpose: "task", usage, taskId: id });
      return res;
    },
  };
  return r;
}

/**
 * Asks you and waits, with your note if you wrote one. Nobody answering within 24 hours, or a
 * cancelled approval, ends the task. `away` waits without holding what other tasks could use.
 */
export async function askOwner(
  tasks: Tasks,
  id: number,
  input: Omit<NewApproval, "taskId"> & { summary: string },
  url: string | null,
  away: (answer: () => Promise<Outcome>) => Promise<Outcome>,
  signal: AbortSignal,
): Promise<{ outcome: Outcome; note: string | null }> {
  const { approvals } = tasks.d;
  const approval = approvals.create({ taskId: id, ...input });
  const step = (name: string) =>
    tasks.addStep(id, { kind: "approval", name, detail: input.summary, url });
  step("Asked for approval");
  const outcome = await away(() => approvals.wait(approval.id, signal));
  step(`Approval ${outcome}`);
  if (outcome === "expired")
    throw new Stop("cancelled", "Nobody answered the approval within 24 hours.");
  if (outcome === "cancelled") throw new Stop("cancelled", "The approval was cancelled.");
  const note = approvals.get(approval.id)?.note ?? null;
  if (note) tasks.addStep(id, { kind: "note", name: "Your note", detail: note, url });
  return { outcome, note };
}

export const textOf = (res: Anthropic.Beta.BetaMessage) =>
  res.content
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("")
    .trim();

/** A reply's text and thinking, as notes on the task's timeline. */
export function addNotes(
  tasks: Tasks,
  id: number,
  res: Anthropic.Beta.BetaMessage,
  url: string | null = null,
) {
  for (const b of res.content) {
    const note = b.type === "text" ? b.text : b.type === "thinking" ? b.thinking : "";
    if (note.trim()) tasks.addStep(id, { kind: "note", name: "Note", detail: note.trim(), url });
  }
}

/**
 * The tool calls a reply makes, or null for the run to go on without any: a paused turn, or a reply
 * that called no tool, for which `nudge` says what it's told once, returning false once it has been.
 * A reply that ends the run throws Stop; `escalate`: one a stronger model might carry on from.
 */
export function callsOf(
  res: Anthropic.Beta.BetaMessage,
  nudge: () => boolean,
  escalate = false,
): Anthropic.Beta.BetaToolUseBlock[] | null {
  const account = (text: string | null) => escalate && { account: text };
  if (res.stop_reason === "refusal")
    throw new Stop("failed", "The model declined to carry on with this task.", true, account(""));
  // Asking it what it tried wouldn't fit either; another model starts afresh without its account.
  if (res.stop_reason === "model_context_window_exceeded")
    throw new Stop("failed", "Stopped: the task's conversation got too long.", true, account(""));
  if (res.stop_reason === "pause_turn") return null;
  const calls = res.content.filter(
    (b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use",
  );
  if (calls.length) return calls;
  if (cutOff(res)) throw new Stop("failed", "Stopped: a reply was cut off.", true, account(null));
  // Only a finishing tool ends a task: asked once, then it has failed.
  if (nudge()) return null;
  const text = textOf(res);
  throw new Stop(
    "failed",
    text || "Stopped: it ended without finishing.",
    true,
    account(text || null),
  );
}

/** How a run that ended by throwing ends its task: as a Stop says, cancelled, or failed. */
export function endOf(
  err: unknown,
  id: number,
  signal: AbortSignal,
): { status: "done" | "failed" | "cancelled"; summary: string; notify?: boolean } {
  if (err instanceof Stop) return { status: err.status, summary: err.summary, notify: err.notify };
  if (signal.aborted) {
    const paused = signal.reason instanceof Error && signal.reason.message === "paused";
    return { status: "cancelled", summary: paused ? "Stopped by Pause all." : "Cancelled." };
  }
  if (err instanceof DesktopError)
    return {
      status: "failed",
      summary:
        err.status === 0 ? "The desktop stopped answering." : `The desktop failed: ${err.message}`,
    };
  console.error(`task ${id} failed`, err);
  return {
    status: "failed",
    summary: `Something went wrong talking to the model (${modelErrorText(err)}).`,
  };
}
