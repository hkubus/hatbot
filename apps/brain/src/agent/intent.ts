// Haiku's checks on an action a task would otherwise ask you to approve: whether you already asked for
// it (PLAN.md §6.2), and whether it's safe despite the untrusted content the task has read (§6.1).
import type Anthropic from "@anthropic-ai/sdk";
import type { ApprovalKind } from "@hatbot/shared";
import type { Spend } from "../spend";
import type { ModelClient } from "./model";
import { INTENT_PROMPT, REVIEW_PROMPT } from "./prompt";

const INTENT_MODEL = "claude-haiku-5-5";

/** These always ask, whatever you said: money, accounts, spending more, and suspected injection. */
const ALWAYS_ASK: ApprovalKind[] = [
  "payment",
  "purchase",
  "account_security",
  "budget",
  "injection_warning",
];

export const mayCheck = (kind: ApprovalKind) => !ALWAYS_ASK.includes(kind);

/** Haiku's JSON reply to one check; null on any failure or a cut-off reply. */
async function haikuJson(
  d: { model: ModelClient; spend: Spend },
  ref: Ref,
  purpose: string,
  system: string,
  content: string,
): Promise<Record<string, unknown> | null> {
  try {
    const res = await d.model.create({
      model: INTENT_MODEL,
      max_tokens: 2000,
      thinking: { type: "adaptive" },
      output_config: { effort: "low" },
      system,
      messages: [{ role: "user", content }],
    });
    d.spend.recordResponse({ model: INTENT_MODEL, purpose, usage: res.usage, ...ref });
    if (res.stop_reason !== "end_turn") return null;
    const out = res.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    return JSON.parse(/\{[\s\S]*\}/.exec(out)?.[0] ?? "{}") as Record<string, unknown>;
  } catch (err) {
    console.error(`approval check (${purpose}) failed; asking instead`, err);
    return null;
  }
}

const whyOf = (json: Record<string, unknown> | null) =>
  typeof json?.why === "string" ? json.why : "";

type Action = { tool: string; input: unknown; what: string; why: string };
/** Who the check is for, for the spend ledger: a task, or a chat conversation. */
type Ref = { taskId?: number; episodeId?: number };

/**
 * Asks Haiku whether `ownerSaid` (your own chat messages) explicitly asked for this action. Any failure
 * or unclear answer is a no, so the task asks.
 */
export async function ownerAsked(
  d: { model: ModelClient; spend: Spend },
  ref: Ref,
  ownerSaid: string,
  action: Action,
): Promise<{ asked: boolean; why: string }> {
  const json = await haikuJson(
    d,
    ref,
    "intent",
    INTENT_PROMPT,
    `<owner_said>\n${ownerSaid}\n</owner_said>\n\n<action>\n${JSON.stringify({ tool: action.tool, input: action.input, summary: action.what, would_ask_because: action.why })}\n</action>`,
  );
  return { asked: json?.asked === true, why: whyOf(json) };
}

/**
 * Asks Haiku whether a tainted task's change is safe to make without you: nothing destructive or
 * dangerous, and nothing the untrusted content could have put there. Whether the task needs it isn't
 * Haiku's call. Haiku never sees that content, only its sources. Any failure is unsafe, so the task asks.
 */
export async function safeDespiteTaint(
  d: { model: ModelClient; spend: Spend },
  ref: Ref,
  context: { ownerSaid: string | null; goal: string; sources: string[] },
  action: Action,
): Promise<{ safe: boolean; why: string }> {
  const json = await haikuJson(
    d,
    ref,
    "review",
    REVIEW_PROMPT,
    [
      `<owner_said>\n${context.ownerSaid ?? "(nothing the owner wrote is available for this task)"}\n</owner_said>`,
      `<task_goal>\n${context.goal}\n</task_goal>`,
      `<untrusted_sources>\n${JSON.stringify(context.sources)}\n</untrusted_sources>`,
      `<action>\n${JSON.stringify({ tool: action.tool, input: action.input, summary: action.what })}\n</action>`,
    ].join("\n\n"),
  );
  return { safe: json?.safe === true, why: whyOf(json) };
}
