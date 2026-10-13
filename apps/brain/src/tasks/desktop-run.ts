// run_desktop_task: the computer- and browser-use subloop (PLAN.md §5.5, §5.6, §6.1).
import type Anthropic from "@anthropic-ai/sdk";
import {
  BetaAbstractBrowserToolset20260801,
  BetaAbstractComputerToolset20260801,
  type BetaBrowserMemberResult,
  type BetaBrowserState,
} from "@anthropic-ai/sdk/helpers/beta/toolsets";
import type { BetaBrowserMemberInput } from "@anthropic-ai/sdk/resources/beta";
import type { ApprovalKind } from "@hatbot/shared";
import type { AgentElement, BrowserState, ComputerMember } from "@hatbot/shared/desktop";
import { z } from "zod";
import { modelErrorText } from "../agent/model";
import { DESKTOP_PROMPT } from "../agent/prompt";
import { screenPage } from "../agent/screening";
import { localStamp } from "../agent/thread";
import { type Outcome, ownerNote } from "../approvals";
import { promptFor } from "../bots";
import { type DesktopAgent, DesktopError } from "../desktop/client";
import { destructive } from "../plugins/ssh/policy";
import { BudgetError, priceOf } from "../spend";
import { skillPath } from "../teach/skills";
import { checkFor, consequential } from "./policy";
import type { Tasks } from "./service";

/** Models whose between-tool progress notes (`display: "updates"`) are documented. */
export const UPDATES_MODELS = new Set(["claude-opus-5-5"]);
const MAX_STEPS = 80;
const MAX_ACTIVE_MS = 30 * 60_000;
const TAKEOVER_TIMEOUT_MS = 24 * 3600_000;
const BETAS: Anthropic.Beta.AnthropicBeta[] = [
  "thinking-display-updates-2026-08-18",
  "context-management-2025-06-27",
];

type BlockParam = Anthropic.Beta.BetaContentBlockParam;
type ToolResult = Anthropic.Beta.BetaToolResultBlockParam;

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
const DesktopShell = z.object({
  command: z.string().min(1).max(20_000).describe("A bash command; it runs in your shell's home"),
  timeout_s: z
    .number()
    .int()
    .min(1)
    .max(600)
    .optional()
    .describe("Seconds before it's killed; 60 if left out"),
});
const SendFile = z
  .object({
    download_id: z.string().max(100).optional().describe("A finished browser download's id"),
    path: z.string().max(500).optional().describe("A file in desktop_shell's home, relative to it"),
    name: z.string().max(200).optional().describe("The name the owner sees, if not the file's own"),
  })
  .refine((v) => !!v.download_id !== !!v.path, "Give either download_id or path.");
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
      "Ask the owner to take control of the desktop: to log in, enter a password, 2FA code or payment details, solve a captcha challenge, or get you unstuck. Returns when they hand it back, with the current screen.",
    schema: RequestTakeover,
  },
  {
    name: "desktop_shell",
    description:
      "Run a bash command on the desktop as a separate shell user, and get its exit code and output as text. Use it for computing, scripts, downloading and processing files, and trying things out: it's faster than typing into a terminal on screen. Its home (/var/lib/hatbot-shell) persists between tasks. It can't see the browser profile, the browser's downloads or the screen, has no sudo, and reaches the internet but not the owner's network. Commands that delete data recursively or the like ask the owner first.",
    schema: DesktopShell,
  },
  {
    name: "send_file",
    description:
      "Send the owner a file: a browser download once it's completed (download_id), or one desktop_shell made (path). It shows with the task's result, for them to open or save. Up to 25 MB.",
    schema: SendFile,
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

/** The browser toolset on desktop-agent's CDP driver. Like Computer, the run checks policy before calling it. */
class Browser extends BetaAbstractBrowserToolset20260801 {
  constructor(
    private agent: DesktopAgent,
    private onImage: (bytes: Uint8Array) => Promise<void>,
  ) {
    super({ browserState: async () => (await agent.browserState()) as BetaBrowserState });
  }

  protected override async execute(
    _ctx: unknown,
    name: string,
    input: BetaBrowserMemberInput,
  ): Promise<BetaBrowserMemberResult> {
    const r = await this.agent.browser({ name, input: input as Record<string, unknown> });
    switch (r.kind) {
      case "image":
        await this.onImage(Buffer.from(r.data, "base64"));
        return { data: r.data, mediaType: r.mediaType };
      case "navigate":
        return { url: r.url, ...(r.title ? { title: r.title } : {}) };
      case "tab":
        return r.tab;
      case "tabs":
        return r.tabs;
      default:
        return r.text;
    }
  }
}

/** The open tabs, for the model in place of a screenshot. */
const tabsText = (state: BrowserState) =>
  state.tabs.length
    ? state.tabs
        .map((t) => `- ${t.tab_id}: "${t.title}" (${t.url})${t.active ? " (current)" : ""}`)
        .join("\n")
    : "No tabs are open.";

/** Halt text for the calls after a failed one in the same turn, per toolset. */
const NOT_EXECUTED: Record<string, string> = {
  computer: "Not executed: an earlier computer action in this turn failed.",
  browser: "Not executed: an earlier action in this turn failed.",
};

const describe = (name: string, input: Record<string, unknown>): string => {
  const target = input.target as
    | { type?: string; ref?: string; x?: number; y?: number }
    | undefined;
  const at = Array.isArray(input.coordinate)
    ? ` at (${input.coordinate.join(", ")})`
    : target?.type === "ref"
      ? ` on ${target.ref}`
      : target?.type === "coordinate"
        ? ` at (${target.x}, ${target.y})`
        : "";
  switch (name) {
    case "navigate":
      return String(input.url);
    case "find":
      return String(input.query);
    case "read_page":
      return [input.filter, input.ref].filter(Boolean).join(" ");
    case "form_input":
      return `${at.trim()} = "${String(input.value).slice(0, 80)}"`;
    case "switch_tab":
    case "close_tab":
      return String(input.tab_id);
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
function estimateCost(messages: Anthropic.Beta.BetaMessageParam[], model: string): number {
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
  const p = priceOf(model);
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
    d.desktop.setActiveTask(id, task.botId);
    tasks.setStatus(id, "running");
  };
  const release = () => {
    if (!holding) return;
    activeMs += tasks.clock() - since;
    holding = false;
    tasks.lane.release(id);
    const holder = tasks.lane.holderId;
    d.desktop.setActiveTask(holder, holder === null ? null : (tasks.get(holder)?.botId ?? null));
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
      tasks.taint(id, lastUrl ? `The page at ${lastUrl}` : "What was on the screen");
    }
    return path;
  };

  let pendingStepId: number | undefined;
  const onImage = async (bytes: Uint8Array) => {
    await capture(bytes, "Screenshot", "screenshot", pendingStepId);
  };
  const computer = new Computer(agent, onImage);
  const browser = new Browser(agent, onImage);
  /**
   * What the model gets to see after a pause (start, approval, takeover): the open tabs, so it reads only
   * what it needs. The timeline gets a screenshot.
   */
  const look = async (label: string, lead: string): Promise<BlockParam[]> => {
    await capture(await agent.screenshot(), label);
    const state = await agent.browserState().catch(() => null);
    return [
      {
        type: "text",
        text: `${lead} ${state ? `The browser's tabs:\n${tabsText(state)}` : "The browser isn't answering; take a screenshot."}`,
      },
    ];
  };

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
  }): Promise<{ outcome: Outcome; note: string | null }> => {
    const approval = d.approvals.create({
      taskId: id,
      botId: task.botId,
      sources: [...sources],
      ...input,
    });
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
    const note = d.approvals.get(approval.id)?.note ?? null;
    if (note) tasks.addStep(id, { kind: "note", name: "Your note", detail: note, url: lastUrl });
    return { outcome, note };
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
      const { outcome } = await askApproval({
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

  /**
   * Runs one toolset call (computer or browser): waits out a takeover, holds back a consequential click or
   * Enter until confirm_intent approves it (PLAN.md §6.1), then logs and runs it.
   */
  const toolsetCall = async (call: Anthropic.Beta.BetaToolUseBlock): Promise<ToolResult> => {
    const input = (call.input ?? {}) as Record<string, unknown>;
    const isBrowser = call.toolset_name === "browser";
    if (d.desktop.get().control === "owner") {
      await waitForOwner();
      return textResult(
        call,
        await look(
          "After takeover",
          "Not run: the owner took control of the desktop and has now handed it back. It may have changed.",
        ),
      );
    }
    const check = checkFor(call.name, input);
    if (check) {
      let el: AgentElement | null;
      if (isBrowser) {
        const t = input.target as
          | { type?: string; ref?: string; x?: number; y?: number }
          | undefined;
        const at =
          check === "enter" ? {} : t?.type === "ref" ? { ref: t.ref } : { x: t?.x, y: t?.y };
        const tab = typeof input.tab_id === "string" ? { tab_id: input.tab_id } : {};
        el = await agent.browserInspect({ ...at, ...tab }).catch(() => null);
      } else {
        let point = input.coordinate as number[] | undefined;
        if (check === "click" && !point) {
          const r = await agent.action({ name: "cursor_position", input: {} });
          point = [r.x ?? 0, r.y ?? 0];
        }
        el = await agent.inspect(point?.[0], point?.[1]).catch(() => null);
      }
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
      return await (isBrowser ? browser : computer).toolResult(call);
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
    const { outcome, note } = await askApproval({ ...p.data, screenshotStepId: step.id });
    if (outcome !== "approved") {
      return textResult(
        call,
        note
          ? `The owner denied this. Don't do it. ${ownerNote(note)}`
          : "The owner denied this. Don't do it. Finish the task, or carry on another way that doesn't need it.",
      );
    }
    armed = true;
    return textResult(
      call,
      await look(
        "After approval",
        note
          ? `Approved by the owner. ${ownerNote(note)}`
          : "Approved by the owner. Go ahead with exactly this action.",
      ),
    );
  };

  /** The desktop's shell. Destructive patterns ask, as on your hosts (PLAN.md §5.5). */
  const shellCall = async (call: Anthropic.Beta.BetaToolUseBlock): Promise<ToolResult> => {
    const p = DesktopShell.safeParse(call.input);
    if (!p.success) return textResult(call, `Invalid input: ${z.prettifyError(p.error)}`, true);
    const { command, timeout_s: timeoutS = 60 } = p.data;
    if (d.desktop.get().control === "owner") await waitForOwner();
    const danger = destructive(command);
    let note: string | null = null;
    if (danger) {
      const answer = await askApproval({
        kind: danger.kind,
        summary: `On the desktop: ${command}`,
        reason: `This command ${danger.why}.`,
      });
      note = answer.note;
      if (answer.outcome !== "approved")
        return textResult(
          call,
          note
            ? `The owner denied this. ${ownerNote(note)}`
            : "The owner denied this. Don't try it another way.",
          true,
        );
    }
    tasks.addStep(id, { kind: "action", name: "desktop_shell", detail: command, url: null });
    const r = await agent.exec(command, timeoutS);
    const head = r.timedOut ? `Killed after ${timeoutS} s.` : `Exit code ${r.exitCode}`;
    return textResult(
      call,
      `${head}\n${r.output}${note ? `\n\n${ownerNote(note)}` : ""}`,
      r.timedOut || r.exitCode !== 0,
    );
  };

  const sendFile = async (call: Anthropic.Beta.BetaToolUseBlock): Promise<ToolResult> => {
    const p = SendFile.safeParse(call.input);
    if (!p.success) return textResult(call, `Invalid input: ${z.prettifyError(p.error)}`, true);
    if (!d.attachments) return textResult(call, "Files can't be sent here.", true);
    try {
      const a = await d.attachments.fromDesktop(
        agent,
        { download: p.data.download_id, path: p.data.path, name: p.data.name },
        { taskId: id },
      );
      tasks.addStep(id, { kind: "action", name: "send_file", detail: a.name, url: null });
      return textResult(call, `Sent "${a.name}".`);
    } catch (err) {
      if (err instanceof DesktopError) return textResult(call, err.message, true);
      throw err;
    }
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
      title: `${d.bots.nameOf(task.botId)} needs you: ${p.data.reason}`.slice(0, 120),
      message: `Task #${id}: ${task.title}. Open the live view, take over, and hand back when you're done.`,
      priority: 4,
      click: `${d.config.publicUrl}/tasks/${id}?live=1`,
    });
    await waitForOwner();
    d.desktop.clearRequest(id);
    tasks.addStep(id, { kind: "takeover", name: "You handed back", detail: "", url: lastUrl });
    return textResult(call, await look("After takeover", "The owner handed the desktop back."));
  };

  // Its bot's name; the desktop model needs no role or memory.
  const system = promptFor(DESKTOP_PROMPT, { ...tasks.botOf(task), instructions: "" }, []);

  try {
    // The owner saved it (PLAN.md §5.4), so it's trusted like the task itself.
    const skill =
      task.skill && (await d.memory.exists(skillPath(task.skill)))
        ? `<skill name="${task.skill}">\n${(await d.memory.read(skillPath(task.skill))).trim()}\n</skill>\n\n`
        : "";
    await acquire();
    const first = await look(
      "Start",
      `${skill}<task>\n${task.goal}\nDone when: ${task.successCriteria || "the goal is met"}\n</task>\nStarted ${localStamp(new Date(tasks.clock()))}, the owner's local time.`,
    );
    await observePage();
    record("user", first);

    for (let step = 0; ; step++) {
      if (signal.aborted) throw signal.reason;
      if (step >= MAX_STEPS)
        throw new Stop("failed", `Stopped after ${MAX_STEPS} steps without finishing.`);
      if (activeMs + (holding ? tasks.clock() - since : 0) > MAX_ACTIVE_MS) {
        throw new Stop("failed", "Stopped: it ran for 30 minutes without finishing.");
      }
      try {
        d.spend.check(estimateCost(messages, task.model), { id, limitUsd: tasks.budget(id) });
      } catch (err) {
        if (!(err instanceof BudgetError)) throw err;
        if (err.limit !== "task") throw new Stop("failed", `Stopped: ${err.message}`);
        const extra = d.settings.get().limits.taskUsd;
        const { outcome } = await askApproval({
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
          model: task.model,
          max_tokens: 16000,
          betas: BETAS,
          system: [{ type: "text", text: system }],
          cache_control: { type: "ephemeral" },
          tools: [computer.toJSON(), browser.toJSON(), ...CUSTOM_TOOLS],
          thinking: UPDATES_MODELS.has(task.model)
            ? { type: "adaptive", display: "updates" }
            : { type: "adaptive" },
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
        model: task.model,
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
      /** Toolsets whose batch stopped at a failure this turn: their later calls don't run. */
      const halted = new Set<string>();
      for (const call of calls) {
        const toolset = call.toolset_name ?? "";
        if (res.stop_reason === "max_tokens") {
          results.push(
            textResult(call, "Input was cut off at max_tokens. Retry with a shorter input.", true),
          );
        } else if (finished) {
          results.push(textResult(call, "Not run: the task already finished.", true));
        } else if (halted.has(toolset)) {
          results.push(textResult(call, NOT_EXECUTED[toolset] as string, true));
        } else if (toolset === "computer" || toolset === "browser") {
          const r = await toolsetCall(call);
          if (r.is_error) halted.add(toolset);
          results.push(r);
        } else if (call.name === "confirm_intent") {
          results.push(await confirmIntent(call));
        } else if (call.name === "request_takeover") {
          results.push(await requestTakeover(call));
        } else if (call.name === "desktop_shell") {
          results.push(await shellCall(call));
        } else if (call.name === "send_file") {
          results.push(await sendFile(call));
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
      tasks.finish(
        id,
        "failed",
        `Something went wrong talking to the model (${modelErrorText(err)}).`,
      );
    }
  } finally {
    release();
    d.approvals.cancelForTask(id);
    d.desktop.clearRequest(id);
  }
}
