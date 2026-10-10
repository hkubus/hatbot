// Whether you already asked for an action a task would otherwise ask you to approve (PLAN.md §6.2).
import type Anthropic from "@anthropic-ai/sdk";
import type { ApprovalKind } from "@hatbot/shared";
import type { Spend } from "../spend";
import type { ModelClient } from "./model";
import { INTENT_PROMPT } from "./prompt";

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

/**
 * Asks Haiku whether `ownerSaid` (your own chat messages) explicitly asked for this action. Any failure
 * or unclear answer is a no, so the task asks.
 */
export async function ownerAsked(
  d: { model: ModelClient; spend: Spend },
  taskId: number,
  ownerSaid: string,
  action: { tool: string; input: unknown; what: string; why: string },
): Promise<{ asked: boolean; why: string }> {
  try {
    const res = await d.model.create({
      model: INTENT_MODEL,
      max_tokens: 2000,
      thinking: { type: "adaptive" },
      output_config: { effort: "low" },
      system: INTENT_PROMPT,
      messages: [
        {
          role: "user",
          content: `<owner_said>\n${ownerSaid}\n</owner_said>\n\n<action>\n${JSON.stringify({ tool: action.tool, input: action.input, summary: action.what, would_ask_because: action.why })}\n</action>`,
        },
      ],
    });
    d.spend.recordResponse({ model: INTENT_MODEL, purpose: "intent", usage: res.usage, taskId });
    const out = res.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    const json = JSON.parse(/\{[\s\S]*\}/.exec(out)?.[0] ?? "{}") as {
      asked?: unknown;
      why?: unknown;
    };
    return {
      asked: res.stop_reason === "end_turn" && json.asked === true,
      why: typeof json.why === "string" ? json.why.slice(0, 200) : "",
    };
  } catch (err) {
    console.error("approval check failed; asking instead", err);
    return { asked: false, why: "" };
  }
}
