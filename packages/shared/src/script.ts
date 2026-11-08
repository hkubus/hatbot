// Scripts: steps a bot writes once, which the brain runs without the model: tool calls, checks on
// what they answered, and what to tell you.
import { z } from "zod";
import { BOT_ID } from "./bot-id";

export const COMPARISONS = [
  "equals",
  "not_equals",
  "above",
  "below",
  "contains",
  "not_contains",
  "matches",
  "empty",
  "not_empty",
] as const;
export type Comparison = (typeof COMPARISONS)[number];

export type ScriptCondition =
  | { all: ScriptCondition[] }
  | { any: ScriptCondition[] }
  | { not: ScriptCondition }
  | { value: unknown; is: Comparison; to?: unknown };

export type ScriptStep =
  /** A tool's answer, as JSON when it's JSON, goes in `as`. `optional`: a failure doesn't stop it. */
  | { call: string; input?: Record<string, unknown>; as?: string; optional?: boolean }
  | { if: ScriptCondition; do: ScriptStep[]; else?: ScriptStep[] }
  | { each: string; as: string; do: ScriptStep[] }
  | { set: string; to: unknown }
  /** Adds to the list in `add`, making it if it isn't there. */
  | { add: string; value: unknown }
  /** In the script's thread, with a notification. */
  | { notify: string }
  /** A quiet note in the bot's chat. */
  | { post: string }
  /** A background task with this prompt and what the script has found: for what needs judgement. */
  | { task: string; title?: string }
  /** Ends the run here, with this as its result. */
  | { stop: string; failed?: boolean };

export type ScriptInput = { name: string; description: string };

export type Script = {
  id: number;
  botId: string;
  /** Lowercase words joined with hyphens, unique for its bot. */
  name: string;
  description: string;
  inputs: ScriptInput[];
  steps: ScriptStep[];
  /** The tools it changes things with, when it was saved. */
  writes: string[];
  /** You approved it as it is, so its changes run without the review. */
  approved: boolean;
  enabled: boolean;
  createdVia: "chat" | "owner";
  /** The chat wrote it after reading untrusted content, so its runs start tainted. */
  tainted: boolean;
  taintedBy: string | null;
  createdAt: string;
  updatedAt: string;
  lastRunAt: string | null;
  lastTaskId: number | null;
};

export const SCRIPT_NAME = /^[a-z0-9][a-z0-9-]{0,47}$/;
const VAR = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;
/** What a script may hold: in all, nested or not. */
export const MAX_SCRIPT_STEPS = 200;
const MAX_DEPTH = 6;

const text = z.string().trim().min(1).max(4000);
const variable = z
  .string()
  .regex(VAR, "a name of letters, digits and _, starting with a letter")
  .refine((v) => !["input", "now"].includes(v), "input and now are taken");

export const ScriptConditionSchema: z.ZodType<ScriptCondition> = z.lazy(() =>
  z.union([
    z.strictObject({ all: z.array(ScriptConditionSchema).min(1).max(20) }),
    z.strictObject({ any: z.array(ScriptConditionSchema).min(1).max(20) }),
    z.strictObject({ not: ScriptConditionSchema }),
    z.strictObject({ value: z.unknown(), is: z.enum(COMPARISONS), to: z.unknown().optional() }),
  ]),
);

export const ScriptStepSchema: z.ZodType<ScriptStep> = z.lazy(() =>
  z.union([
    z.strictObject({
      call: z.string().min(1).max(100),
      input: z.record(z.string(), z.unknown()).optional(),
      as: variable.optional(),
      optional: z.boolean().optional(),
    }),
    z.strictObject({
      if: ScriptConditionSchema,
      do: z.array(ScriptStepSchema),
      else: z.array(ScriptStepSchema).optional(),
    }),
    z.strictObject({
      each: z.string().min(1).max(200),
      as: variable,
      do: z.array(ScriptStepSchema),
    }),
    z.strictObject({ set: variable, to: z.unknown() }),
    z.strictObject({ add: variable, value: z.unknown() }),
    z.strictObject({ notify: text }),
    z.strictObject({ post: text }),
    z.strictObject({ task: text, title: z.string().trim().min(1).max(80).optional() }),
    z.strictObject({ stop: text, failed: z.boolean().optional() }),
  ]),
);

/** Every step, nested ones too, with how deep it sits. */
export function* stepsIn(steps: ScriptStep[], depth = 1): Generator<[ScriptStep, number]> {
  for (const s of steps) {
    yield [s, depth];
    if ("if" in s) {
      yield* stepsIn(s.do, depth + 1);
      if (s.else) yield* stepsIn(s.else, depth + 1);
    } else if ("each" in s) yield* stepsIn(s.do, depth + 1);
  }
}

export const ScriptSteps = z
  .array(ScriptStepSchema)
  .min(1)
  .superRefine((steps, ctx) => {
    let n = 0;
    for (const [, depth] of stepsIn(steps)) {
      n++;
      if (depth > MAX_DEPTH) {
        ctx.addIssue({ code: "custom", message: `Steps nest at most ${MAX_DEPTH} deep.` });
        return;
      }
    }
    if (n > MAX_SCRIPT_STEPS)
      ctx.addIssue({ code: "custom", message: `A script has at most ${MAX_SCRIPT_STEPS} steps.` });
  });

export const ScriptInputSchema = z.strictObject({
  name: variable,
  description: z.string().trim().max(300).default(""),
});

export const SaveScript = z.object({
  name: z.string().regex(SCRIPT_NAME, "lowercase words joined with hyphens, like check-backups"),
  description: z.string().trim().min(1).max(500),
  inputs: z.array(ScriptInputSchema).max(10).default([]),
  steps: ScriptSteps,
  enabled: z.boolean().default(true),
  botId: z.string().regex(BOT_ID).default("hatbot"),
});
export const UpdateScript = SaveScript.partial();

export const RunScript = z.object({ input: z.record(z.string(), z.unknown()).default({}) });

/** What a script's run is started with, as its task's job. */
export type ScriptJob = { script: number; input: Record<string, unknown> };

const shown = (v: unknown) =>
  typeof v === "string"
    ? /^\{\{[^{}]+\}\}$/.test(v.trim())
      ? v.trim()
      : `"${v}"`
    : JSON.stringify(v);

const WORDS: Record<Comparison, string> = {
  equals: "equals",
  not_equals: "doesn't equal",
  above: "is above",
  below: "is below",
  contains: "contains",
  not_contains: "doesn't contain",
  matches: "matches",
  empty: "is empty",
  not_empty: "isn't empty",
};

export function describeScriptCondition(c: ScriptCondition): string {
  if ("all" in c) return c.all.map((x) => `(${describeScriptCondition(x)})`).join(" and ");
  if ("any" in c) return c.any.map((x) => `(${describeScriptCondition(x)})`).join(" or ");
  if ("not" in c) return `not (${describeScriptCondition(c.not)})`;
  const left = `${shown(c.value)} ${WORDS[c.is]}`;
  return c.is === "empty" || c.is === "not_empty" ? left : `${left} ${shown(c.to)}`;
}

function describeStep(s: ScriptStep): string {
  if ("call" in s) {
    const input = s.input && Object.keys(s.input).length ? ` with ${JSON.stringify(s.input)}` : "";
    return `Call ${s.call}${input}${s.as ? `, as ${s.as}` : ""}${s.optional ? ", going on if it fails" : ""}`;
  }
  if ("if" in s) return `If ${describeScriptCondition(s.if)}:`;
  if ("each" in s) return `For each ${s.as} in ${s.each}:`;
  if ("set" in s) return `Set ${s.set} to ${shown(s.to)}`;
  if ("add" in s) return `Add ${shown(s.value)} to ${s.add}`;
  if ("notify" in s) return `Tell you: ${s.notify}`;
  if ("post" in s) return `Note in the chat: ${s.post}`;
  if ("task" in s) return `Start a task${s.title ? ` "${s.title}"` : ""}: ${s.task}`;
  return `${s.failed ? "Fail" : "Stop"}: ${s.stop}`;
}

/** The steps as numbered lines, in the order stepsIn() counts them, nested ones indented. */
export function describeSteps(steps: ScriptStep[]): string[] {
  const lines: string[] = [];
  let n = 0;
  const walk = (list: ScriptStep[], depth: number) => {
    for (const s of list) {
      n++;
      lines.push(`${n}. ${"  ".repeat(depth)}${describeStep(s)}`);
      if ("if" in s) {
        walk(s.do, depth + 1);
        if (s.else?.length) {
          lines.push(`   ${"  ".repeat(depth)}Otherwise:`);
          walk(s.else, depth + 1);
        }
      } else if ("each" in s) walk(s.do, depth + 1);
    }
  };
  walk(steps, 0);
  return lines;
}
