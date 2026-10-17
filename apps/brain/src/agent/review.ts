// Haiku's review of a change that would otherwise ask you to approve it (PLAN.md §6.1): if it isn't
// destructive or dangerous, and nothing untrusted could have put it there, it goes ahead.
import type Anthropic from "@anthropic-ai/sdk";
import type { ApprovalKind } from "@hatbot/shared";
import type { Verdict } from "../plugins/plugin";
import { fixedTokens, requestCeiling, type Spend } from "../spend";
import type { ModelClient } from "./model";
import { REVIEW_PROMPT } from "./prompt";
import { tagJson } from "./untrusted";

const REVIEW_MODEL = "claude-haiku-5-5";

const VERDICT = {
  type: "object",
  properties: { safe: { type: "boolean" }, why: { type: "string" } },
  required: ["safe", "why"],
  additionalProperties: false,
};

/** These always ask: money, accounts, spending more, and suspected injection. */
const ALWAYS_ASK: ApprovalKind[] = [
  "payment",
  "purchase",
  "account_security",
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
    const content = [
      `<owner_said>\n${context.ownerSaid ?? "(nothing the owner wrote is available for this task)"}\n</owner_said>`,
      `<task_goal>\n${context.goal}\n</task_goal>`,
      `<untrusted_sources>\n${tagJson(context.sources)}\n</untrusted_sources>`,
      `<action>\n${tagJson({ tool: action.tool, input: action.input, summary: action.what, would_ask_because: action.why })}\n</action>`,
    ].join("\n\n");
    // Past a limit it throws, and the change asks you instead.
    d.spend.check(
      requestCeiling(REVIEW_MODEL, {
        prompt: fixedTokens(REVIEW_PROMPT, content),
        maxTokens: 2000,
      }),
    );
    const res = await d.model.create({
      model: REVIEW_MODEL,
      // Room for thinking, so it can't crowd out the verdict.
      max_tokens: 4000,
      thinking: { type: "adaptive" },
      output_config: { effort: "low", format: { type: "json_schema", schema: VERDICT } },
      system: REVIEW_PROMPT,
      messages: [{ role: "user", content }],
    });
    d.spend.recordResponse({ model: REVIEW_MODEL, purpose: "review", usage: res.usage, ...ref });
    if (res.stop_reason !== "end_turn") return { safe: false, why: "" };
    const out = res.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    const json = JSON.parse(out) as Record<string, unknown>;
    return { safe: json.safe === true, why: typeof json.why === "string" ? json.why : "" };
  } catch (err) {
    console.error("approval review failed; asking instead", err);
    return { safe: false, why: "" };
  }
}
