// The review of a change a tool or untrusted content flags: if it isn't destructive or dangerous, and
// nothing untrusted could have put it there, it goes ahead; otherwise it's blocked, and the bot finds
// another way. The small model looks first, and the expert model looks again before a block.

import type { PluginTool, Verdict } from "@hatbot/plugin-sdk";
import { localStamp, tagJson } from "@hatbot/plugin-sdk";
import {
  type ApprovalKind,
  type ApprovalLevel,
  SAFETY_KINDS,
  type SafetyKind,
} from "@hatbot/shared";
import { modelName } from "../models-known";
import { describeCall } from "../plugins/registry";
import type { Settings, SettingsStore } from "../settings";
import type { Spend } from "../spend";
import { type ModelClient, oneShot } from "./model";
import { REVIEW_PROMPT } from "./prompt";
import { tagText } from "./untrusted";

/** Room for thinking at high effort, so it can't crowd out the verdict. */
const REVIEW_MAX_TOKENS = 8000;

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

/** Approvals you may stretch past this once: not money, accounts, doors or what's careful. */
export const scopable = (verdict: Extract<Verdict, { action: "ask" }>) =>
  !verdict.always && !ALWAYS_ASK.includes(verdict.kind ?? "other");

/** Whether an ask goes to you, to the review first, or ahead, as Safety settings say. */
export function levelOf(
  settings: Settings,
  verdict: Extract<Verdict, { action: "ask" }>,
): ApprovalLevel {
  if (verdict.careful) return "ask";
  const kind = verdict.kind ?? "other";
  if (!SAFETY_KINDS.includes(kind as SafetyKind)) return "ask";
  const level = settings.safety.kinds[kind as SafetyKind];
  return level === "review" && (verdict.always || !settings.reviewChanges) ? "ask" : level;
}

/** What the bot is told when the review blocks a change. */
export const blockedText = (why: string) =>
  `Blocked by the safety review${why ? `: ${why.replace(/\.$/, "")}` : ""}. Don't try the same thing again. Find another way, or finish and say what was blocked: the owner can run it anyway.`;

/** Blocks a run takes before it stops: so many in a row, or so many in all. */
export const BLOCKS_IN_A_ROW = 3;
export const BLOCKS_IN_ALL = 20;

/** A run's blocks so far; `blocked()` says why it stops once there are too many. */
export class Blocks {
  private row = 0;
  private all = 0;

  blocked(): string | null {
    this.row++;
    this.all++;
    if (this.row >= BLOCKS_IN_A_ROW)
      return `the safety review blocked ${this.row} changes in a row`;
    if (this.all >= BLOCKS_IN_ALL) return `the safety review blocked ${this.all} changes`;
    return null;
  }

  ran() {
    this.row = 0;
  }
}

/** Room for the chat, and for each message's end, where its questions are. */
const SAID_CHARS = 8000;
const SAID_EACH = 1500;

/**
 * A change in the chat has no goal: instead the review sees the chat, the owner's messages between
 * the bot's, so their short replies ("yeah") answer something. `said`: oldest first.
 */
export function chatGoal(said: { owner: boolean; text: string; at: Date }[]): string {
  const lines: string[] = [];
  let left = SAID_CHARS;
  for (const m of [...said].reverse()) {
    if (left <= 0) break;
    const text = m.text.length > SAID_EACH ? `…${m.text.slice(-SAID_EACH)}` : m.text;
    const line = `[${localStamp(m.at)}] ${m.owner ? "The owner" : "Hatbot"}: ${text}`;
    lines.unshift(line.slice(-left));
    left -= line.length;
  }
  return lines.length
    ? `None: the owner is asking in the chat. The chat so far, oldest first, which shows what their replies answer. Their lines are also in <owner_said>, and only those count as theirs; like a goal, Hatbot's may be written from what it read:\n\n${lines.join("\n\n")}`
    : "(none: the owner is asking in the chat)";
}

/** The latest changes the review sees, and room for each. */
const MADE_MOST = 20;
const MADE_FIELD = 150;
const MADE_CHARS = 400;

/** Whether a call is a change the review is told of afterwards. */
export function changes(t: PluginTool, input: unknown): boolean {
  if (t.access === "read") return false;
  if (typeof t.looks !== "function") return !t.looks;
  const parsed = t.schema.safeParse(input);
  return !parsed.success || !t.looks(parsed.data);
}

/** A change a reply or task made, as the review sees it: what its tool says it does, or its input cut short. */
export function changeMade(t: PluginTool, input: unknown): string {
  const line = t.describe
    ? describeCall(t, input)
    : `${t.name} ${JSON.stringify(input ?? {}, (_, v) => (typeof v === "string" && v.length > MADE_FIELD ? `${v.slice(0, MADE_FIELD)}…` : v))}`;
  return line.length > MADE_CHARS ? `${line.slice(0, MADE_CHARS)}…` : line;
}

/** `by`: the reviewing model's name. */
export type Review = { safe: boolean; why: string; by: string };

/**
 * Whether it's needed isn't the review's call. Neither model sees untrusted content, only its sources.
 * `reserve`: alert and heartbeat work, which may spend what's kept for alerts.
 */
export async function safeToRun(
  d: { model: ModelClient; spend: Spend; settings: SettingsStore },
  ref: { taskId?: number; episodeId?: number },
  context: { ownerSaid: string | null; goal: string; sources: string[]; made?: string[] },
  action: { tool: string; input: unknown; what: string; why: string; change?: string },
  { reserve = false }: { reserve?: boolean } = {},
): Promise<Review> {
  // The goal may be written from untrusted content, so neither it nor the owner's words can close
  // their tag and open another.
  const content = [
    `<owner_said>\n${context.ownerSaid === null ? "(nothing the owner wrote is available for this task)" : tagText(context.ownerSaid)}\n</owner_said>`,
    `<task_goal>\n${tagText(context.goal)}\n</task_goal>`,
    `<changes_made>\n${tagJson((context.made ?? []).slice(-MADE_MOST))}\n</changes_made>`,
    `<untrusted_sources>\n${tagJson(context.sources)}\n</untrusted_sources>`,
    `<action>\n${tagJson({
      tool: action.tool,
      ...(action.change === undefined ? { input: action.input } : { change: action.change }),
      summary: action.what,
      would_ask_because: action.why,
    })}\n</action>`,
  ].join("\n\n");
  const { smallModel, expertModel } = d.settings.get();
  const models = [...new Set([smallModel, expertModel])];
  // A review that couldn't run blocks.
  let review: Review = { safe: false, why: "it couldn't be checked", by: modelName(smallModel) };
  for (const model of models) {
    const by = modelName(model);
    try {
      const out = await oneShot(
        d,
        {
          model,
          max_tokens: REVIEW_MAX_TOKENS,
          thinking: { type: "adaptive" },
          // Low and medium effort stopped many safe changes the owner then had to approve.
          output_config: { effort: "high", format: { type: "json_schema", schema: VERDICT } },
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
