// The review of a change that would otherwise ask you to approve it: if it isn't destructive or
// dangerous, and nothing untrusted could have put it there, it goes ahead. Haiku looks first, and Opus
// looks again before a no reaches you.
import type { ApprovalKind, ApprovalScope } from "@hatbot/shared";
import type { Verdict } from "../plugins/plugin";
import type { Spend } from "../spend";
import { type ModelClient, oneShot } from "./model";
import { REVIEW_PROMPT } from "./prompt";
import { tagJson, tagText } from "./untrusted";

const REVIEWERS = [
  { by: "Haiku", model: "claude-haiku-5-5" },
  { by: "Opus", model: "claude-opus-5-5" },
] as const;
/** Room for thinking, so it can't crowd out the verdict. */
const REVIEW_MAX_TOKENS = 4000;

const VERDICT = {
  type: "object",
  properties: { safe: { type: "boolean" }, why: { type: "string" } },
  required: ["safe", "why"],
  additionalProperties: false,
};

const ALWAYS_ASK: ApprovalKind[] = [
  "payment",
  "purchase",
  "account_security",
  "access",
  "budget",
  "injection_warning",
];

export const mayReview = (verdict: Extract<Verdict, { action: "ask" }>, suspected = false) =>
  !suspected && !verdict.always && !ALWAYS_ASK.includes(verdict.kind ?? "other");

/** Where only untrusted content asks, you may also approve the tool for the rest of the work. */
export const scopesFor = (verdict: Extract<Verdict, { action: "ask" }>): ApprovalScope[] =>
  verdict.tainted ? ["session", "always"] : ["always"];

export type Review = { safe: boolean; why: string; by: (typeof REVIEWERS)[number]["by"] };

/**
 * Whether it's needed isn't the review's call. Neither model sees untrusted content, only its sources.
 * `reserve`: alert and heartbeat work, which may spend what's kept for alerts.
 */
export async function safeToRun(
  d: { model: ModelClient; spend: Spend },
  ref: { taskId?: number; episodeId?: number },
  context: { ownerSaid: string | null; goal: string; sources: string[] },
  action: { tool: string; input: unknown; what: string; why: string },
  { reserve = false }: { reserve?: boolean } = {},
): Promise<Review> {
  // The goal may be written from untrusted content, so neither it nor the owner's words can close
  // their tag and open another.
  const content = [
    `<owner_said>\n${context.ownerSaid === null ? "(nothing the owner wrote is available for this task)" : tagText(context.ownerSaid)}\n</owner_said>`,
    `<task_goal>\n${tagText(context.goal)}\n</task_goal>`,
    `<untrusted_sources>\n${tagJson(context.sources)}\n</untrusted_sources>`,
    `<action>\n${tagJson({ tool: action.tool, input: action.input, summary: action.what, would_ask_because: action.why })}\n</action>`,
  ].join("\n\n");
  let review: Review = { safe: false, why: "", by: "Haiku" };
  for (const { by, model } of REVIEWERS) {
    try {
      const out = await oneShot(
        d,
        {
          model,
          max_tokens: REVIEW_MAX_TOKENS,
          thinking: { type: "adaptive" },
          output_config: { effort: "low", format: { type: "json_schema", schema: VERDICT } },
          system: REVIEW_PROMPT,
          messages: [{ role: "user", content }],
        },
        { purpose: "review", ...ref },
        { reserve },
      );
      const json = JSON.parse(out) as Record<string, unknown>;
      review = { safe: json.safe === true, why: typeof json.why === "string" ? json.why : "", by };
      if (review.safe) return review;
    } catch (err) {
      console.error(`approval review by ${by} failed`, err);
    }
  }
  return review;
}
