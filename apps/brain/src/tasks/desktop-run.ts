// run_desktop_task: the Opus computer-use subloop (PLAN.md §5.5, §5.6, §6.1).
import type Anthropic from "@anthropic-ai/sdk";
import { BetaAbstractComputerToolset20260801 } from "@anthropic-ai/sdk/helpers/beta/toolsets";
import type { ApprovalKind } from "@hatbot/shared";
import type { ComputerMember } from "@hatbot/shared/desktop";
import { z } from "zod";
import { DESKTOP_PROMPT } from "../agent/prompt";
import { screenPage } from "../agent/screening";
import { localStamp } from "../agent/thread";
import type { Outcome } from "../approvals";
import { type DesktopAgent, DesktopError } from "../desktop/client";
import { BudgetError, priceOf } from "../spend";
import { checkFor, consequential } from "./policy";
import type { Tasks } from "./service";

export const DESKTOP_MODEL = "claude-opus-5-5";
const MAX_STEPS = 80;
const MAX_ACTIVE_MS = 30 * 60_000;
const TAKEOVER_TIMEOUT_MS = 24 * 3600_000;
const BETAS: Anthropic.Beta.AnthropicBeta[] = [
  "thinking-display-updates-2026-08-18",
  "context-management-2025-06-27",
];

type BlockParam = Anthropic.Beta.BetaContentBlockParam;
type ToolResult = Anthropic.Beta.BetaToolResultBlockParam;
type ImageBlock = Anthropic.Beta.BetaImageBlockParam;

const ConfirmIntent = z.object({
  kind: z.enum([
    "send",
    "submit_personal_data",
    "purchase",
    "payment",
    "delete",
    "account_security",
    "other",
  ]),
  summary: z
    .string()
    .min(1)
    .max(300)
    .describe(
      'The one action you are about to take, e.g. "Click Book to reserve a table for 2 at Luigi\'s, Fri 24 Oct 19:30"',
    ),
  reason: z.string().max(500).optional().describe("Why, if it isn't obvious from the task"),
});
const RequestTakeover = z.object({
  reason: z
    .string()
    .min(1)
    .max(200)
    .describe('What the owner needs to do, e.g. "Log in to OpenTable"'),
});
const FinishTask = z.object({
  outcome: z.enum(["done", "failed", "blocked"]),
  summary: z.string().min(1).max(2000).describe("What you did and the result, for the owner"),
});

const CUSTOM_TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: "confirm_intent",
    description:
      "Ask the owner to approve one consequential action before you take it: sending or posting, submitting personal details, buying, paying, booking, deleting, or changing account or security settings. Returns once they decide.",
    schema: ConfirmIntent,
  },
  {
    name: "request_takeover",
    description:
      "Ask the owner to take control of the desktop: to log in, enter a password, 2FA code or payment details, solve a captcha, or get you unstuck. Returns when they hand it back, with the current screen.",
    schema: RequestTakeover,
  },
  {
    name: "finish_task",
    description: "End the task and report the outcome to the owner.",
    schema: FinishTask,
  },
].map((t) => ({
  name: t.name,
  description: t.description,
  input_schema: z.toJSONSchema(t.schema) as Anthropic.Beta.BetaTool.InputSchema,
  eager_input_streaming: true,
}));

/** Ends the run from inside a helper. `notify` false: a routine result nobody needs to hear about. */
export class Stop extends Error {
  constructor(
    readonly status: "done" | "failed" | "cancelled",
    readonly summary: string,
    readonly notify = true,
  ) {
    super(summary);
  }
}

/** The computer toolset on desktop-agent. The SDK formats results; the run checks policy before calling it. */
class Computer extends BetaAbstractComputerToolset20260801 {
  constructor(
    private agent: DesktopAgent,
    private onImage: (bytes: Uint8Array) => Promise<void>,
  ) {
    // Typing and keys need a confirm hook; the run applies its own policy before each call instead.
    super({ confirm: () => true });
  }

  protected override async execute(
    _ctx: unknown,
    name: ComputerMember,
    input: Record<string, unknown>,
  ) {
    if (name === "screenshot" || name === "zoom") {
      const bytes =
        name === "zoom"
          ? await this.agent.zoom(input.region as number[])
          : await this.agent.screenshot();
      await this.onImage(bytes);
      return { data: Buffer.from(bytes).toString("base64"), mediaType: "image/webp" as const };
    }
    const r = await this.agent.action({ name, input });
    if (name === "cursor_position") return { x: r.x ?? 0, y: r.y ?? 0 };
    return r.text;
  }
}

const describe = (name: string, input: Record<string, unknown>): string => {
  const at = Array.isArray(input.coordinate) ? ` at (${input.coordinate.join(", ")})` : "";
  switch (name) {
    case "type":
      return `"${String(input.text).slice(0, 80)}${String(input.text).length > 80 ? "…" : ""}"`;
    case "key":
    case "hold_key":
      return String(input.text);
    case "scroll":
      return `${input.scroll_direction} ${input.scroll_amount}${at}`;
    case "wait":
      return `${input.duration}s`;
    case "zoom":
      return `[${(input.region as number[] | undefined)?.join(", ")}]`;
    case "left_click_drag":
      return `from (${(input.start_coordinate as number[] | undefined)?.join(", ")})${at.replace(" at", " to")}`;
    default:
      return (input.text ? `${input.text} + ` : "") + at.trim();
  }
};

/** Rough upper estimate before a request: text by length, images at their typical size. */
function estimateCost(messages: Anthropic.Beta.BetaMessageParam[]): number {
  let chars = 0;
  let images = 0;
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (o.type === "image") images++;
      else
        for (const [k, x] of Object.entries(o)) {
          if (typeof x !== "string") walk(x);
          else if (k !== "data") chars += x.length;
        }
    }
  };
  walk(messages);
  const p = priceOf(DESKTOP_MODEL);
  const tokens = chars / 3.5 + images * 1600 + 3000;
  return (tokens * p.input * 0.3 + 1500 * p.output) / 1_000_000;
}

export async function runDesktopTask(tasks: Tasks, id: number, signal: AbortSignal): Promise<void> {
  const { d } = tasks;
  const task = tasks.get(id);
  if (!task) return;
  const agent = d.desktop.agent;

  let holding = false;
  let activeMs = 0;
  let since = 0;
  let seq = 0;
  let lastUrl: string | null = null;
  /** An approved confirm_intent covers the next consequential action. */
  let armed = false;
  const sources = new Set<string>();
  const trustedHosts = new Set<string>();
  const messages: Anthropic.Beta.BetaMessageParam[] = [];
  /** Archive paths of the images in `messages`, so the stored transcript references files. */
  const imagePaths = new Map<string, string>();

  const acquire = async () => {
    await tasks.lane.acquire(id, signal);
    holding = true;
    since = tasks.clock();
    d.desktop.setActiveTask(id);
    tasks.setStatus(id, "running");
  };
  const release = () => {
    if (!holding) return;
    activeMs += tasks.clock() - since;
    holding = false;
    tasks.lane.release(id);
    d.desktop.setActiveTask(tasks.lane.holderId);
  };
  /** Waits for you with the screen released (PLAN.md §5.6), then queues for it again. */
  const away = async <T>(fn: () => Promise<T>): Promise<T> => {
    release();
    tasks.setStatus(id, "waiting_approval");
    const out = await fn();
    await acquire();
    return out;
  };

  const capture = async (
    bytes: Uint8Array,
    label: string,
    kind: "screenshot" | "action" = "screenshot",
    stepId?: number,
  ) => {
    const path = await d.archive.saveScreen(id, String(++seq).padStart(4, "0"), bytes);
    imagePaths.set(Buffer.from(bytes).toString("base64"), path);
    if (stepId) tasks.setStepScreenshot(stepId, path);
    else tasks.addStep(id, { kind, name: label, detail: "", url: lastUrl, screenshot: path });
    if (!task.tainted) {
      // The screen shows untrusted content from here on (PLAN.md §6.1).
      task.tainted = true;
      tasks.mark(id, "tainted");
    }
    return path;
  };
  const screen = async (label: string): Promise<ImageBlock> => {
    const bytes = await agent.screenshot();
    await capture(bytes, label);
    return {
      type: "image",
      source: {
        type: "base64",
        media_type: "image/webp",
        data: Buffer.from(bytes).toString("base64"),
      },
    };
  };

  let pendingStepId: number | undefined;
  const computer = new Computer(agent, async (bytes) => {
    await capture(bytes, "Screenshot", "screenshot", pendingStepId);
  });

  const record = (
    role: "user" | "assistant",
    content: BlockParam[] | Anthropic.Beta.BetaContentBlock[],
  ) => {
    messages.push({ role, content: content as BlockParam[] });
    const stored = JSON.parse(JSON.stringify(content), (k, v) =>
      k === "data" && typeof v === "string" && imagePaths.has(v)
        ? `archive:${imagePaths.get(v)}`
        : v,
    );
    tasks.appendTurn(id, role, stored);
  };

  const askApproval = async (input: {
    kind: ApprovalKind;
    summary: string;
    reason?: string;
    screenshotStepId?: number | null;
  }): Promise<Outcome> => {
    const approval = d.approvals.create({ taskId: id, sources: [...sources], ...input });
    tasks.addStep(id, {
      kind: "approval",
      name: "Asked for approval",
      detail: input.summary,
      url: lastUrl,
    });
    const outcome = await away(() => d.approvals.wait(approval.id, signal));
    tasks.addStep(id, {
      kind: "approval",
      name: `Approval ${outcome}`,
      detail: input.summary,
      url: lastUrl,
    });
    if (outcome === "expired")
      throw new Stop("cancelled", "Nobody answered the approval within 24 hours.");
    if (outcome === "cancelled") throw new Stop("cancelled", "The approval was cancelled.");
    return outcome;
  };

  /** Waits while you have the desktop, holding the screen lane: you're working on this task's behalf. */
  const waitForOwner = async () => {
    tasks.setStatus(id, "waiting_takeover");
    activeMs += tasks.clock() - since;
    const timeout = AbortSignal.timeout(TAKEOVER_TIMEOUT_MS);
    try {
      await d.desktop.waitForHandback(AbortSignal.any([signal, timeout]));
    } catch (err) {
      if (timeout.aborted && !signal.aborted)
        throw new Stop("cancelled", "Nobody handed the desktop back within 24 hours.");
      throw err;
    }
    since = tasks.clock();
    tasks.setStatus(id, "running");
  };

  /** Logs page changes and screens each new page for prompt injection. */
  const observePage = async () => {
    const ctx = await agent.context(false).catch(() => null);
    const url = ctx?.url?.split("#")[0] ?? null;
    if (!url || url === lastUrl) return;
    lastUrl = url;
    if (!/^https?:/.test(url)) return;
    sources.add(url.slice(0, 300));
    tasks.addStep(id, { kind: "page", name: ctx?.title || url, detail: "", url });
    const host = new URL(url).host;
    if (trustedHosts.has(host)) return;
    try {
      const page = await agent.context(true);
      const verdict = await screenPage(d.model, d.spend, id, {
        url,
        title: page.title,
        text: page.text ?? "",
      });
      if (!verdict.suspected) return;
      tasks.mark(id, "injection_suspected");
      tasks.addStep(id, {
        kind: "note",
        name: "Possible prompt injection",
        detail: verdict.excerpt,
        url,
      });
      const outcome = await askApproval({
        kind: "injection_warning",
        summary: `Keep going on ${host}?`,
        reason: `This page may contain instructions aimed at Hatbot: "${verdict.excerpt}"`,
      });
      if (outcome !== "approved")
        throw new Stop("cancelled", `Stopped on ${host}: the page may contain a prompt injection.`);
      trustedHosts.add(host);
    } catch (err) {
      if (err instanceof Stop || signal.aborted) throw err;
      console.error(`task ${id}: page screening failed`, err);
    }
  };

  const textResult = (
    call: Anthropic.Beta.BetaToolUseBlock,
    content: string | BlockParam[],
    isError = false,
  ): ToolResult => ({
    type: "tool_result",
    tool_use_id: call.id,
    content: content as ToolResult["content"],
    ...(isError ? { is_error: true } : {}),
    ...(call.toolset_name ? { toolset_name: call.toolset_name } : {}),
  });

  const computerCall = async (call: Anthropic.Beta.BetaToolUseBlock): Promise<ToolResult> => {
    const input = (call.input ?? {}) as Record<string, unknown>;
    if (d.desktop.get().control === "owner") {
      await waitForOwner();
      return textResult(call, [
        {
          type: "text",
          text: "Not run: the owner took control of the desktop and has now handed it back. The screen may have changed:",
        },
        await screen("After takeover"),
      ]);
    }
    const check = checkFor(call.name, input);
    if (check) {
      let point = input.coordinate as number[] | undefined;
      if (check === "click" && !point) {
        const r = await agent.action({ name: "cursor_position", input: {} });
        point = [r.x ?? 0, r.y ?? 0];
      }
      const el = await agent.inspect(point?.[0], point?.[1]).catch(() => null);
      const label = consequential(check, el);
      if (label && !armed) {
        tasks.addStep(id, {
          kind: "note",
          name: "Held back",
          detail: `${call.name} on "${label}" needs approval`,
          url: lastUrl,
        });
        return textResult(
          call,
          `Not run: this would ${check === "click" ? "click" : "submit with"} "${label}", which looks like a consequential step. If it's the step you mean to take, call confirm_intent first. If not, carry on.`,
          true,
        );
      }
      if (label) armed = false;
    }
    const step = tasks.addStep(id, {
      kind: call.name === "screenshot" ? "screenshot" : "action",
      name: call.name,
      detail: describe(call.name, input),
      url: lastUrl,
    });
    pendingStepId = step.id;
    try {
      return await computer.toolResult(call);
    } finally {
      pendingStepId = undefined;
    }
  };

  const confirmIntent = async (call: Anthropic.Beta.BetaToolUseBlock): Promise<ToolResult> => {
    const p = ConfirmIntent.safeParse(call.input);
    if (!p.success) return textResult(call, `Invalid input: ${z.prettifyError(p.error)}`, true);
    const bytes = await agent.screenshot();
    const step = tasks.addStep(id, {
      kind: "screenshot",
      name: "Before approval",
      detail: "",
      url: lastUrl,
    });
    await capture(bytes, "Before approval", "screenshot", step.id);
    const outcome = await askApproval({ ...p.data, screenshotStepId: step.id });
    if (outcome !== "approved") {
      return textResult(
        call,
        "The owner denied this. Don't do it. Finish the task, or carry on another way that doesn't need it.",
      );
    }
    armed = true;
    return textResult(call, [
      {
        type: "text",
        text: "Approved by the owner. Go ahead with exactly this action. The screen now:",
      },
      await screen("After approval"),
    ]);
  };

  const requestTakeover = async (call: Anthropic.Beta.BetaToolUseBlock): Promise<ToolResult> => {
    const p = RequestTakeover.safeParse(call.input);
    if (!p.success) return textResult(call, `Invalid input: ${z.prettifyError(p.error)}`, true);
    d.desktop.requestTakeover(id, p.data.reason);
    tasks.addStep(id, {
      kind: "takeover",
      name: "Asked you to take over",
      detail: p.data.reason,
      url: lastUrl,
    });
    void d.notifier.send({
      title: `Hatbot needs you: ${p.data.reason}`.slice(0, 120),
      message: `Task #${id}: ${task.title}. Open the live view, take over, and hand back when you're done.`,
      priority: 4,
      click: `${d.config.publicUrl}/tasks/${id}?live=1`,
    });
    await waitForOwner();
    d.desktop.clearRequest(id);
    tasks.addStep(id, { kind: "takeover", name: "You handed back", detail: "", url: lastUrl });
    return textResult(call, [
      { type: "text", text: "The owner handed the desktop back. The screen now:" },
      await screen("After takeover"),
    ]);
  };

  try {
    await acquire();
    const first = await screen("Start");
    await observePage();
    record("user", [
      {
        type: "text",
        text: `<task>\n${task.goal}\nDone when: ${task.successCriteria || "the goal is met"}\n</task>\nStarted ${localStamp(new Date(tasks.clock()))}, the owner's local time. The screen now:`,
      },
      first,
    ]);

    for (let step = 0; ; step++) {
      if (signal.aborted) throw signal.reason;
      if (step >= MAX_STEPS)
        throw new Stop("failed", `Stopped after ${MAX_STEPS} steps without finishing.`);
      if (activeMs + (holding ? tasks.clock() - since : 0) > MAX_ACTIVE_MS) {
        throw new Stop("failed", "Stopped: it ran for 30 minutes without finishing.");
      }
      try {
        d.spend.check(estimateCost(messages), { id, limitUsd: tasks.budget(id) });
      } catch (err) {
        if (!(err instanceof BudgetError)) throw err;
        if (err.limit !== "task") throw new Stop("failed", `Stopped: ${err.message}`);
        const extra = d.settings.get().limits.taskUsd;
        const outcome = await askApproval({
          kind: "budget",
          summary: `Let task #${id} spend $${extra} more`,
          reason: `"${task.title}" has used its $${tasks.budget(id)} limit.`,
        });
        if (outcome !== "approved") throw new Stop("failed", "Stopped at its spending limit.");
        tasks.raiseBudget(id, extra);
        continue;
      }

      const res = await d.model.stream(
        {
          model: DESKTOP_MODEL,
          max_tokens: 16000,
          betas: BETAS,
          system: [{ type: "text", text: DESKTOP_PROMPT }],
          cache_control: { type: "ephemeral" },
          tools: [computer.toJSON(), ...CUSTOM_TOOLS],
          thinking: { type: "adaptive", display: "updates" },
          output_config: { effort: "medium" },
          // Old screenshots are cleared on the server; clearing them here would break cached reasoning.
          context_management: {
            edits: [
              {
                type: "clear_tool_uses_20250919",
                trigger: { type: "input_tokens", value: 80_000 },
                keep: { type: "tool_uses", value: 8 },
                clear_at_least: { type: "input_tokens", value: 30_000 },
                exclude_tools: ["confirm_intent", "request_takeover", "finish_task"],
              },
            ],
          },
          messages,
        },
        {
          onText: (text) => d.events.emit({ type: "task.progress", taskId: id, text }),
          onThinking: (text) => d.events.emit({ type: "task.progress", taskId: id, text }),
          signal,
        },
      );
      d.spend.recordResponse({
        model: DESKTOP_MODEL,
        purpose: "task",
        usage: res.usage,
        taskId: id,
      });
      record("assistant", res.content);
      for (const b of res.content) {
        const note = b.type === "text" ? b.text : b.type === "thinking" ? b.thinking : "";
        if (note.trim())
          tasks.addStep(id, { kind: "note", name: "Note", detail: note.trim(), url: lastUrl });
      }

      if (res.stop_reason === "refusal")
        throw new Stop("failed", "The model declined to carry on with this task.");
      if (res.stop_reason === "pause_turn") continue;
      const calls = res.content.filter(
        (b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use",
      );
      if (!calls.length) {
        if (res.stop_reason === "max_tokens")
          throw new Stop("failed", "Stopped: a reply was cut off.");
        const text = res.content
          .map((b) => (b.type === "text" ? b.text : ""))
          .join("")
          .trim();
        throw new Stop("done", text || "Finished.");
      }

      const results: BlockParam[] = [];
      let finished: z.infer<typeof FinishTask> | null = null;
      for (const call of calls) {
        if (res.stop_reason === "max_tokens") {
          results.push(
            textResult(call, "Input was cut off at max_tokens. Retry with a shorter input.", true),
          );
        } else if (finished) {
          results.push(textResult(call, "Not run: the task already finished.", true));
        } else if (call.toolset_name === "computer") {
          results.push(await computerCall(call));
        } else if (call.name === "confirm_intent") {
          results.push(await confirmIntent(call));
        } else if (call.name === "request_takeover") {
          results.push(await requestTakeover(call));
        } else if (call.name === "finish_task") {
          const p = FinishTask.safeParse(call.input);
          if (p.success) finished = p.data;
          results.push(
            textResult(
              call,
              p.success ? "Finished." : `Invalid input: ${z.prettifyError(p.error)}`,
              !p.success,
            ),
          );
        } else {
          results.push(textResult(call, `Unknown tool "${call.name}".`, true));
        }
      }
      if (finished) {
        const prefix = finished.outcome === "blocked" ? "Blocked: " : "";
        throw new Stop(finished.outcome === "done" ? "done" : "failed", prefix + finished.summary);
      }
      await observePage();
      record("user", results);
    }
  } catch (err) {
    if (err instanceof Stop) tasks.finish(id, err.status, err.summary);
    else if (signal.aborted) {
      const paused = signal.reason instanceof Error && signal.reason.message === "paused";
      tasks.finish(id, "cancelled", paused ? "Stopped by Pause all." : "Cancelled.");
    } else if (err instanceof DesktopError) {
      tasks.finish(
        id,
        "failed",
        err.status === 0 ? "The desktop stopped answering." : `The desktop failed: ${err.message}`,
      );
    } else {
      console.error(`task ${id} failed`, err);
      tasks.finish(id, "failed", "Something went wrong talking to the model.");
    }
  } finally {
    release();
    d.approvals.cancelForTask(id);
    d.desktop.clearRequest(id);
  }
}
