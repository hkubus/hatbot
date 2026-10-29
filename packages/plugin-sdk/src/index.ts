// The core decides who gets a tool and when it needs your approval; a plugin only says what its tools do.
import type { Database } from "bun:sqlite";
import { API_PREFIX, type ApprovalKind, type Attachment, type Task } from "@hatbot/shared";
import type { FetchResult, RenderResult, ShellResult } from "@hatbot/shared/desktop";
import { Hono } from "hono";
import type { z } from "zod";

/** The API's major version. A plugin built for another one isn't started. */
export const SDK_VERSION = 1;

export type Db = Database;

export class SandboxError extends Error {
  constructor(
    message: string,
    /** 400: the action was invalid (tell the model). 423: the owner has control. 0: unreachable. */
    readonly status: number,
  ) {
    super(message);
  }
}

/** A machine for scratch work: commands, files, and pages fetched or drawn by a real browser. */
export interface Sandbox {
  readonly configured: boolean;
  exec(command: string, timeoutS: number): Promise<ShellResult>;
  putFile(path: string, bytes: Uint8Array): Promise<void>;
  getFile(path: string): Promise<Uint8Array>;
  fetch(url: string): Promise<FetchResult>;
  render(url: string): Promise<RenderResult>;
  /** Calls made through it stop when `signal` does. */
  withSignal?(signal: AbortSignal): Sandbox;
}

export interface PluginAttachments {
  get(id: number): Attachment | null;
  bytes(id: number): Promise<Uint8Array | null>;
}

/** The core takes the strictest of this and the untrusted-content rule. */
export type Verdict =
  /** `covered`: an approval already given (e.g. a negotiation's mandate) stands in for the untrusted-content rule's. */
  | { action: "allow"; covered?: string }
  /**
   * `tainted`: only the untrusted-content rule asks. `always`: Haiku's review can't let it through.
   * `careful`: you marked it to ask you, so Safety settings can't let it through either.
   */
  | {
      action: "ask";
      why: string;
      kind?: ApprovalKind;
      tainted?: boolean;
      always?: boolean;
      careful?: boolean;
    }
  | { action: "block"; why: string };

export const allow = (): Verdict => ({ action: "allow" });
export const covered = (why: string): Verdict => ({ action: "allow", covered: why });
export const ask = (why: string, kind?: ApprovalKind): Verdict => ({ action: "ask", why, kind });
export const askAlways = (why: string, kind?: ApprovalKind): Verdict => ({
  action: "ask",
  why,
  kind,
  always: true,
});
export const askCareful = (why: string, kind?: ApprovalKind): Verdict => ({
  action: "ask",
  why,
  kind,
  always: true,
  careful: true,
});
export const block = (why: string): Verdict => ({ action: "block", why });

export type CallContext = {
  /** The task making the call; null for a call from the chat. */
  task: { id: number; tainted: boolean } | null;
  signal: AbortSignal;
  sendFile?: (name: string, bytes: Uint8Array) => Promise<Attachment>;
  /** From the chat: the reply that work the call starts shows under. */
  messageId?: number;
  /** From a task: waits for a task the call started, without holding the task's slot meanwhile. */
  waitForTask?: (taskId: number) => Promise<Task>;
  /** From a box's feed: the result goes to the box's page, not to the model. */
  feed?: boolean;
  progress?: (line: string) => void;
  /** From a task: runs `fn` without holding the task's slot. */
  away?: <T>(fn: () => Promise<T>) => Promise<T>;
};

/** A picture shown to the model with a tool's result. */
export type ToolImage = {
  data: string;
  mediaType: "image/jpeg" | "image/png" | "image/webp" | "image/gif";
};
export type ToolOutput = string | { text: string; images: ToolImage[] };
export const textOf = (out: ToolOutput) => (typeof out === "string" ? out : out.text);

export type PluginTool<I = unknown> = {
  /** Starts with the plugin's id and an underscore. */
  name: string;
  description: string;
  schema: z.ZodType<I>;
  /** Sent to the model instead of `schema`'s JSON Schema: for tools defined elsewhere (MCP servers). */
  jsonSchema?: Record<string, unknown>;
  /** Only tasks get write tools, and their policy applies; the chat may call read tools directly. */
  access: "read" | "write";
  /** The brain calls it itself (listing Scout's flips); it's never offered to the model. */
  brainOnly?: boolean;
  /** Output is untrusted content. Called without `output` before the call: whether it may be. */
  untrusted?: boolean | ((input: I, output?: string) => boolean);
  /** Description and schema written by someone else: whatever is offered it starts tainted. */
  untrustedDefinition?: boolean;
  label?: string;
  describe?: (input: I) => string;
  /** Writes on different targets may run at once; ones on the same target keep their order. */
  target?: (input: I) => string;
  /** Write tools that pay, buy or change accounts: Haiku's review never answers for them. */
  kind?: ApprovalKind;
  /** How many commands a write runs, for the chat's limit. Without it, one. */
  commands?: (input: I) => number;
  /** Without one, a write is allowed. */
  policy?: (input: I, call: CallContext) => Verdict;
  run: (input: I, call: CallContext) => Promise<ToolOutput>;
};

/** Stored loosely: the registry validates input against `schema` before calling. */
export const tool = <I>(t: PluginTool<I>) => t as unknown as PluginTool;

/** An error whose message is fine to show the model and the owner. */
export class PluginError extends Error {
  constructor(
    message: string,
    readonly status = 0,
  ) {
    super(message);
  }
}

/** `api` gives JSON, or text when another type is asked for; `send` the Response itself. */
export function httpApi(name: string, base: string, headers: Record<string, string>) {
  const send = async (
    method: string,
    path: string,
    body?: unknown,
    accept?: string,
    redirect: RequestInit["redirect"] = "follow",
  ): Promise<Response> => {
    let res: Response;
    try {
      res = await fetch(`${base}${path}`, {
        method,
        headers: {
          ...headers,
          ...(accept ? { accept } : {}),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect,
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw new PluginError(`Can't reach ${name}: ${(err as Error).message}`);
    }
    if (res.ok || (redirect === "manual" && res.status >= 300 && res.status < 400)) return res;
    // Most say {"message": ...}, GitHub with {"errors": [...]}; some plain text ("401: Unauthorized").
    const text = (await res.text().catch(() => "")).trim();
    let detail = text.startsWith("<") ? "" : text;
    try {
      const e = JSON.parse(text) as { message?: string; errors?: { message?: string }[] };
      detail = [e.message, ...(e.errors?.map((x) => x.message) ?? [])].filter(Boolean).join(": ");
    } catch {}
    throw new PluginError(
      `${name} said ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`,
      res.status,
    );
  };
  const api = async <T>(method: string, path: string, body?: unknown, accept?: string) => {
    const res = await send(method, path, body, accept);
    if (accept && !accept.endsWith("json")) return (await res.text()) as T;
    return (res.status === 204 ? null : await res.json()) as T;
  };
  return { send, api };
}

export type PluginStatus =
  | { state: "ready" }
  | { state: "needs_setup"; message: string }
  | { state: "error"; message: string };

export type PluginInstance = {
  status: PluginStatus;
  tools: PluginTool[];
  /** For the system prompt while the plugin is ready. */
  guidance?: string;
  /** Settings' Test button. Throws PluginError on failure. */
  test?: () => Promise<string>;
  /** What's wrong right now, for the heartbeat. `key` stays the same while it's the same problem, so it's told once. */
  signals?: () => Promise<PluginSignal[]>;
  /** Calls its settings form makes; throw PluginError to show a message. */
  actions?: Record<string, (args: unknown) => Promise<unknown>>;
  /** What part of a ready plugin is down, or null. The registry calls `recover` with backoff while it says something; `tools` may change after. */
  down?: () => string | null;
  recover?: () => Promise<void>;
  stop?: () => Promise<void> | void;
  /** What it provides, by the names in `provides`. */
  services?: Record<string, unknown>;
  /** Answers the paths in `routes` (and `publicRoutes`); make it with `pluginRoutes()`. */
  routes?: Hono<PluginEnv>;
  /** Jobs the brain runs while it's ready, each every `everyMs`. */
  ticks?: PluginTick[];
  /** Lines for the system prompt, by where the model works, while it's ready. */
  prompt?: Partial<Record<PromptPlace, string>>;
};

export type PluginTick = { name: string; everyMs: number; run: () => unknown };

export type PromptPlace = "chat" | "task" | "research";

export type PluginPrincipal = { kind: "session" | "token"; id: number };

/** A route sees who's asking in `c.env`: null only on a public route. */
export type PluginEnv = {
  Bindings: { principal: PluginPrincipal | null; clientIp: string };
};

/** Under the API's prefix; a PluginError is shown as it is, anything else as "Something went wrong." */
export function pluginRoutes(): Hono<PluginEnv> {
  const app = new Hono<PluginEnv>().basePath(API_PREFIX);
  app.notFound((c) => c.json({ error: "That's gone." }, 404));
  app.onError((err, c) => {
    if (err instanceof PluginError) return c.json({ error: err.message }, 400);
    if ("getResponse" in err && typeof err.getResponse === "function")
      return err.getResponse() as Response;
    console.error(err);
    return c.json({ error: "Something went wrong." }, 500);
  });
  return app;
}

export type PluginSignal = { key: string; text: string };

export type PluginFiles = {
  desktop: Sandbox;
  attachments: PluginAttachments;
};

export type PluginContext<C> = {
  config: C;
  /** What's set in Settings wins over the host's environment. */
  env: Record<string, string | undefined>;
  named: Record<string, string>;
  db: Db;
  files?: PluginFiles;
  /** data/plugins/<id>; not made until it's first needed. */
  dataDir: string;
  /** A service named in `needs`: there whenever the plugin is started. */
  service: <T>(name: string) => T;
  /** Its own small values, kept with Hatbot's settings. */
  store: PluginStore;
  /** Saves values for its `env` variables, as Settings does; plugins reading them restart. */
  saveSecrets: (values: Record<string, string | null>) => Promise<void>;
};

export type PluginStore = {
  get: (key: string) => string | null;
  set: (key: string, value: string | null) => void;
};

export type PluginEnvVar = {
  name: string;
  /** Settings says it's set, never what to. */
  secret?: boolean;
  optional?: boolean;
  hint?: string;
};

export type Plugin<C = unknown> = {
  id: string;
  name: string;
  description: string;
  /** Every field needs a default: `parse({})` must succeed. */
  config: z.ZodType<C>;
  /** Settings wins over /etc/hatbot/*.env; a change there restarts every plugin that reads it. */
  env?: PluginEnvVar[];
  /** It takes secrets by any name too (MCP's ${NAME}). */
  named?: boolean;
  /** The SDK major it was built for; without one, this one. */
  sdk?: number;
  /** Part of Hatbot itself: always on, and not listed in Settings. */
  internal?: boolean;
  /** On until switched off, for what needs no setting up. */
  defaultOn?: boolean;
  /** Every bot gets it, even one limited to some plugins. */
  allBots?: boolean;
  /** Services it gives other plugins once started. */
  provides?: string[];
  /** Services it can't start without; until a plugin provides each, it says so and waits. */
  needs?: string[];
  /** Its own tables: each runs once, in order, on every install that has the plugin. */
  migrations?: string[];
  /** Paths under /api/v1 it answers, for signed-in callers: "/boxes" takes /boxes and below. */
  routes?: string[];
  /** Ones anybody may call, as Hono patterns ("/hooks/:name"); the route checks who it is. */
  publicRoutes?: string[];
  start: (ctx: PluginContext<C>) => Promise<PluginInstance> | PluginInstance;
};

export const definePlugin = <C>(p: Plugin<C>) => p as unknown as Plugin;

export const ready = (tools: PluginTool[], extra: Omit<PluginInstance, "status" | "tools"> = {}) =>
  ({ status: { state: "ready" }, tools, ...extra }) satisfies PluginInstance;
export const needsSetup = (message: string): PluginInstance => ({
  status: { state: "needs_setup", message },
  tools: [],
});
