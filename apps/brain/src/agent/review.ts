// Haiku's review of a change that would otherwise ask you to approve it (PLAN.md §6.1): if it isn't
// destructive or dangerous, and nothing untrusted could have put it there, it goes ahead.
import type { ApprovalKind } from "@hatbot/shared";
import type { Verdict } from "../plugins/plugin";
import type { Spend } from "../spend";
import { type ModelClient, oneShot } from "./model";
import { REVIEW_PROMPT } from "./prompt";
import { tagJson, tagText } from "./untrusted";

const REVIEW_MODEL = "claude-haiku-5-5";
/** Room for thinking, so it can't crowd out the verdict. */
const REVIEW_MAX_TOKENS = 4000;

const VERDICT = {
  type: "object",
  properties: { safe: { type: "boolean" }, why: { type: "string" } },
  required: ["safe", "why"],
  additionalProperties: false,
};

/** These always ask: money, accounts, who can get in, spending more, and suspected injection. */
const ALWAYS_ASK: ApprovalKind[] = [
  "payment",
  "purchase",
  "account_security",
  "access",
  "budget",
  "injection_warning",
];

/**
 * Whether Haiku may let this through: not money or accounts, not one you said to always ask about,
 * and not while something the chat or task read is suspected of being a prompt injection.
 */
export const mayReview = (verdict: Extract<Verdict, { action: "ask" }>, suspected = false) =>
  !suspected && !verdict.always && !ALWAYS_ASK.includes(verdict.kind ?? "other");

/**
 * Asks Haiku whether a change is safe to make without you: nothing destructive or dangerous, and
 * nothing untrusted content could have put there. Whether it's needed isn't Haiku's call. Haiku never
 * sees untrusted content, only its sources. Any failure or unclear answer is unsafe, so it asks.
 */
export async function safeToRun(
  d: { model: ModelClient; spend: Spend },
  ref: { taskId?: number; episodeId?: number },
  context: { ownerSaid: string | null; goal: string; sources: string[] },
  action: { tool: string; input: unknown; what: string; why: string },
): Promise<{ safe: boolean; why: string }> {
  try {
    // The goal may be written from untrusted content, so neither it nor the owner's words can close
    // their tag and open another.
    const content = [
      `<owner_said>\n${context.ownerSaid === null ? "(nothing the owner wrote is available for this task)" : tagText(context.ownerSaid)}\n</owner_said>`,
      `<task_goal>\n${tagText(context.goal)}\n</task_goal>`,
      `<untrusted_sources>\n${tagJson(context.sources)}\n</untrusted_sources>`,
      `<action>\n${tagJson({ tool: action.tool, input: action.input, summary: action.what, would_ask_because: action.why })}\n</action>`,
    ].join("\n\n");
    // Past a limit it throws, and the change asks you instead.
    const out = await oneShot(
      d,
      {
        model: REVIEW_MODEL,
        max_tokens: REVIEW_MAX_TOKENS,
        thinking: { type: "adaptive" },
        output_config: { effort: "low", format: { type: "json_schema", schema: VERDICT } },
        system: REVIEW_PROMPT,
        messages: [{ role: "user", content }],
      },
      { purpose: "review", ...ref },
    );
    const json = JSON.parse(out) as Record<string, unknown>;
    return { safe: json.safe === true, why: typeof json.why === "string" ? json.why : "" };
  } catch (err) {
    console.error("approval review failed; asking instead", err);
    return { safe: false, why: "" };
  }
}
