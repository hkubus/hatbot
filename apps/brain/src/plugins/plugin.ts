// Plugins (PLAN.md §4.5): integrations like Proxmox, SSH, Forgejo and MCP. Each one ships with Hatbot,
// is switched on in Settings, and contributes tools. The core decides who gets a tool and when it needs
// your approval; a plugin only says what its tools do.
import type { ApprovalKind, Attachment, Task } from "@hatbot/shared";
import type { z } from "zod";
import type { Attachments } from "../attachments";
import type { Db } from "../db";
import type { DesktopAgent } from "../desktop/client";

/** Whether a call may run. The core takes the strictest of this and the untrusted-content rule (§6.1). */
export type Verdict =
  /**
   * `covered`: an approval you already gave stands in for the one the untrusted-content rule would ask
   * for, e.g. a negotiation's mandate (PLAN.md §16.1). It says which, for the timeline.
   */
  | { action: "allow"; covered?: string }
  /**
   * `tainted`: only the untrusted-content rule asks. `always`: the owner said to always ask about this,
   * so Haiku's review can't let it through (PLAN.md §6.1).
   */
  | { action: "ask"; why: string; kind?: ApprovalKind; tainted?: boolean; always?: boolean }
  | { action: "block"; why: string };

export const allow = (): Verdict => ({ action: "allow" });
/** Allowed even after untrusted content: `why` names the approval that covers it. */
export const covered = (why: string): Verdict => ({ action: "allow", covered: why });
export const ask = (why: string, kind?: ApprovalKind): Verdict => ({ action: "ask", why, kind });
/** Asks the owner every time: Haiku's review never lets it through. */
export const askAlways = (why: string, kind?: ApprovalKind): Verdict => ({
  action: "ask",
  why,
  kind,
  always: true,
});
export const block = (why: string): Verdict => ({ action: "block", why });

export type CallContext = {
  /** The task making the call; null for a call from the chat. */
  task: { id: number; tainted: boolean } | null;
  signal: AbortSignal;
  /** Puts a file in the chat for the owner: on the reply or the task making the call. */
  sendFile?: (name: string, bytes: Uint8Array) => Promise<Attachment>;
  /** From the chat: the reply being written, which work the call starts shows under. */
  messageId?: number;
  /** From a task: waits for a task the call started, without holding the task's slot meanwhile. */
  waitForTask?: (taskId: number) => Promise<Task>;
};

export type PluginTool<I = unknown> = {
  /** Starts with the plugin's id and an underscore, e.g. proxmox_status. */
  name: string;
  description: string;
  schema: z.ZodType<I>;
  /** Sent to the model instead of `schema`'s JSON Schema: for tools defined elsewhere (MCP servers). */
  jsonSchema?: Record<string, unknown>;
  /**
   * read: looks without changing anything; the chat may call it directly.
   * write: changes something; only tasks get it, and its policy applies.
   */
  access: "read" | "write";
  /**
   * Its output is untrusted content (PLAN.md §6.1), e.g. issue text written by strangers. `output`:
   * what the call returned, once it has; without it, whether its output may be.
   */
  untrusted?: boolean | ((input: I, output?: string) => boolean);
  /**
   * Its description and schema were written by someone else (an MCP server you haven't trusted):
   * whatever is offered it starts tainted, because that text is in the prompt.
   */
  untrustedDefinition?: boolean;
  /** What the chat shows while it runs, e.g. "Checking guests". */
  label?: string;
  /** The call in a line, for the timeline and approvals: "Restart CT 105 (jellyfin)". */
  describe?: (input: I) => string;
  /**
   * Write tools: the thing it acts on, e.g. a host. A task runs changes allowed without asking at
   * once when each acts on a different thing; ones on the same thing keep their order.
   */
  target?: (input: I) => string;
  /**
   * Write tools that pay, buy or change accounts: what approving any call of it is, also when only
   * the untrusted-content rule asks, so Haiku's review never answers for it.
   */
  kind?: ApprovalKind;
  /** How many commands a write runs, for the chat's limit: a shell loop is many. Without it, one. */
  commands?: (input: I) => number;
  /** Write tools: allow, ask you first, or refuse. Without one, a write is allowed. */
  policy?: (input: I, call: CallContext) => Verdict;
  run: (input: I, call: CallContext) => Promise<string>;
};

/** Typed in place, stored loosely: the registry validates input against `schema` before calling. */
export const tool = <I>(t: PluginTool<I>) => t as unknown as PluginTool;

/** An error whose message is fine to show the model and the owner. */
export class PluginError extends Error {}

export type PluginStatus =
  | { state: "ready" }
  /** Missing secrets or settings: the message says what to do. */
  | { state: "needs_setup"; message: string }
  | { state: "error"; message: string };

export type PluginInstance = {
  status: PluginStatus;
  tools: PluginTool[];
  /** A short paragraph for the system prompt while the plugin is ready, e.g. which hosts exist. */
  guidance?: string;
  /** Settings' Test button: a quick check that says what it found. Throws PluginError on failure. */
  test?: () => Promise<string>;
  /**
   * What's wrong right now, for the heartbeat, without the model: a monitor down, a backup failed.
   * `key` stays the same while it's the same problem, so it's told once.
   */
  signals?: () => Promise<PluginSignal[]>;
  /**
   * Calls its settings form makes, e.g. "show the public key" or "forget a host key". They return
   * JSON for the form; throw PluginError to show a message.
   */
  actions?: Record<string, (args: unknown) => Promise<unknown>>;
  /**
   * A ready plugin with a part down, such as an MCP server that wasn't up: what's down, or null.
   * The registry calls `recover` with backoff while it says something; `tools` may change after.
   */
  down?: () => string | null;
  recover?: () => Promise<void>;
  stop?: () => Promise<void> | void;
};

export type PluginSignal = { key: string; text: string };

/** Where Hatbot keeps files of its own, for plugins that move them: the sandbox and the chat's files. */
export type PluginFiles = {
  desktop: DesktopAgent;
  attachments: Attachments;
};

export type PluginContext<C> = {
  config: C;
  env: Record<string, string | undefined>;
  db: Db;
  files?: PluginFiles;
};

export type Plugin<C = unknown> = {
  id: string;
  name: string;
  /** One line for Settings. */
  description: string;
  /** Its settings. Every field needs a default: `parse({})` must succeed. */
  config: z.ZodType<C>;
  /** Environment variables it reads from /etc/hatbot/*.env; Settings shows which are missing. */
  secrets?: string[];
  start: (ctx: PluginContext<C>) => Promise<PluginInstance> | PluginInstance;
};

export const definePlugin = <C>(p: Plugin<C>) => p as unknown as Plugin;

export const ready = (tools: PluginTool[], extra: Omit<PluginInstance, "status" | "tools"> = {}) =>
  ({ status: { state: "ready" }, tools, ...extra }) satisfies PluginInstance;
export const needsSetup = (message: string): PluginInstance => ({
  status: { state: "needs_setup", message },
  tools: [],
});
