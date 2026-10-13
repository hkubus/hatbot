// Haiku's check on an action a task or the chat would otherwise ask you to approve: whether you already
// asked for it (PLAN.md §6.2), and whether it's safe despite the untrusted content read so far (§6.1).
// Both questions go in one call.
import type Anthropic from "@anthropic-ai/sdk";
import type { ApprovalKind } from "@hatbot/shared";
import type { Spend } from "../spend";
import type { ModelClient } from "./model";
import { CHECK_PROMPT } from "./prompt";

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

type Action = { tool: string; input: unknown; what: string; why: string };
/** Who the check is for, for the spend ledger: a task, or a chat conversation. */
type Ref = { taskId?: number; episodeId?: number };

/**
 * One Haiku call for both checks on an action that would otherwise ask you. `asked`: whether
 * `ownerSaid` (your own words) explicitly asked for it. `review` (a tainted task or chat): whether it's
 * safe to make without you: nothing destructive or dangerous, and nothing the untrusted content could
 * have put there. Haiku never sees that content, only its sources. Either yes lets it through; any
 * failure or unclear answer is a no, so it asks. Null when neither check applies.
 */
export async function checkAction(
  d: { model: ModelClient; spend: Spend },
  ref: Ref,
  context: {
    ownerSaid: string | null;
    asked: boolean;
    review: { goal: string; sources: string[] } | null;
  },
  action: Action,
): Promise<{ asked: boolean; safe: boolean; why: string } | null> {
  const asked = context.asked && context.ownerSaid !== null;
  const review = context.review;
  if (!asked && !review) return null;
  const json = await haikuJson(
    d,
    ref,
    "check",
    CHECK_PROMPT,
    [
      `<questions>\n${JSON.stringify([...(asked ? ["asked"] : []), ...(review ? ["safe"] : [])])}\n</questions>`,
      `<owner_said>\n${context.ownerSaid ?? "(nothing the owner wrote is available for this task)"}\n</owner_said>`,
      ...(review
        ? [
            `<task_goal>\n${review.goal}\n</task_goal>`,
            `<untrusted_sources>\n${JSON.stringify(review.sources)}\n</untrusted_sources>`,
          ]
        : []),
      `<action>\n${JSON.stringify({ tool: action.tool, input: action.input, summary: action.what, would_ask_because: action.why })}\n</action>`,
    ].join("\n\n"),
  );
  return {
    asked: asked && json?.asked === true,
    safe: review !== null && json?.safe === true,
    why: typeof json?.why === "string" ? json.why : "",
  };
}
