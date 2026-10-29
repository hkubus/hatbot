import type Anthropic from "@anthropic-ai/sdk";
import type { Task } from "@hatbot/shared";
import { cutOff, modelErrorText, type StreamParams } from "../agent/model";
import { tagText } from "../agent/untrusted";
import type { NewApproval, Outcome } from "../approvals";
import { DesktopError } from "../desktop/client";
import { progressNotes } from "../models-known";
import {
  BudgetError,
  estimateTokens,
  fixedTokens,
  requestCeiling,
  searchesIn,
  usesReserve,
} from "../spend";
import type { Tasks } from "./service";

/** Ends the run from inside a helper. `escalate`: a failure a stronger model might get past. */
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

/** A note the chat sent a running task (`Tasks.steer`). */
export const steerNote = (note: string) => `<steer from="chat">\n${tagText(note)}\n</steer>`;

export const thinkingFor = (model: string) =>
  progressNotes(model)
    ? ({ type: "adaptive", display: "updates" } as const)
    : ({ type: "adaptive" } as const);

type Params = Omit<StreamParams, "stream">;

/** Cache entries last 5 minutes. */
export function requestsFor(tasks: Tasks, task: Task, signal: AbortSignal) {
  const { d } = tasks;
  const { id } = task;
  const r = {
    cache: { tokens: 0, at: 0 },
    release: () => {},

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

    holdOnly: (usd: number) =>
      d.spend.hold(usd, { id, limitUsd: tasks.budget(id) }, { reserve: usesReserve(task.origin) }),

    /** At the task's limit it asks the owner for more and returns false, for the request to be retried. */
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

/** `away` waits without holding what other tasks could use. */
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

/** Null for the run to go on: a paused turn, or a reply with no calls while `nudge()` allows. */
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
