// Haiku's review of a change that would otherwise ask you to approve it (PLAN.md §6.1): if it isn't
// destructive or dangerous, and nothing untrusted could have put it there, it goes ahead.
import type Anthropic from "@anthropic-ai/sdk";
import type { ApprovalKind } from "@hatbot/shared";
import type { Verdict } from "../plugins/plugin";
import type { Spend } from "../spend";
import type { ModelClient } from "./model";
import { REVIEW_PROMPT } from "./prompt";

const REVIEW_MODEL = "claude-haiku-5-5";

/** These always ask: money, accounts, spending more, and suspected injection. */
const ALWAYS_ASK: ApprovalKind[] = [
  "payment",
  "purchase",
  "account_security",
  "budget",
  "injection_warning",
];

/** Whether Haiku may let this through: not money or accounts, and not one you said to always ask about. */
export const mayReview = (verdict: Extract<Verdict, { action: "ask" }>) =>
  !verdict.always && !ALWAYS_ASK.includes(verdict.kind ?? "other");

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
    const res = await d.model.create({
      model: REVIEW_MODEL,
      max_tokens: 2000,
      thinking: { type: "adaptive" },
      output_config: { effort: "low" },
      system: REVIEW_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            `<owner_said>\n${context.ownerSaid ?? "(nothing the owner wrote is available for this task)"}\n</owner_said>`,
            `<task_goal>\n${context.goal}\n</task_goal>`,
            `<untrusted_sources>\n${JSON.stringify(context.sources)}\n</untrusted_sources>`,
            `<action>\n${JSON.stringify({ tool: action.tool, input: action.input, summary: action.what, would_ask_because: action.why })}\n</action>`,
          ].join("\n\n"),
        },
      ],
    });
    d.spend.recordResponse({ model: REVIEW_MODEL, purpose: "review", usage: res.usage, ...ref });
    if (res.stop_reason !== "end_turn") return { safe: false, why: "" };
    const out = res.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    const json = JSON.parse(/\{[\s\S]*\}/.exec(out)?.[0] ?? "{}") as Record<string, unknown>;
    return { safe: json.safe === true, why: typeof json.why === "string" ? json.why : "" };
  } catch (err) {
    console.error("approval review failed; asking instead", err);
    return { safe: false, why: "" };
  }
}
