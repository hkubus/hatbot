// The core decides who gets a tool and when it needs your approval; a plugin only says what its tools do.
import type { Database } from "bun:sqlite";
import {
  API_PREFIX,
  type ApprovalKind,
  type Attachment,
  type Bot,
  type Schedule,
  type Task,
} from "@hatbot/shared";
import type { FetchResult, RenderResult, ShellResult } from "@hatbot/shared/desktop";
import { type Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { z } from "zod";
import type { Hosts, PluginCheck, SearchRoutine, TaskOrigin } from "./host";
import type { ModelProvider } from "./models";
import type { TaskJob, TaskRunner } from "./runner";

/** The brain's own zod, for a plugin installed from git: it needs no copy of its own. */
export { z } from "zod";
export * from "./charts";
export * from "./host";
export * from "./messages";
export * from "./models";
export * from "./runner";

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
  /** A file Hatbot hands the owner, under a task. */
  save(input: {
    bytes: Uint8Array;
    name: string;
    mediaType: string;
    from: "hatbot";
    taskId: number;
  }): Promise<Attachment>;
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
  /** The bot the call is made for. */
  bot?: Bot;
  /** From the chat: the conversation, and the stretch of it the model sees. */
  conversationId?: number;
  episodeId?: number;
  /** What untrusted content was read first, or null: work the call starts begins tainted. */
  tainted?: () => string | null;
  /** Marks the conversation or task as having read untrusted `text`, from `by`. */
  taint?: (by: string, text?: string) => void;
  /** Suspected prompt injection: work it starts is marked so, and the review won't let it through. */
  suspected?: () => Promise<boolean>;
  /** What the owner said in this stretch of the chat. */
  ownerSaid?: () => string;
  /** The hand-off the reply answers, if it answers one. */
  answering?: Task;
  /** For an `own` tool: asks as a write's change asks, the review then you; `always`: only you. */
  approve?: (
    call: { tool: string; input: unknown; what: string; why: string; always?: boolean },
    signal: AbortSignal,
  ) => Promise<{ content: string; isError: boolean }>;
  /** Shows a schedule made in the chat as a card in it. */
  scheduleCard?: (s: Schedule) => void;
};

/** Where the model works: the chat, a background task, or research. */
export type Place = "chat" | "task" | "research";

/** Whether to offer a tool, decided per reply or task. */
export type Offer = { place: Place; bot: Bot; others: Bot[]; incognito: boolean };

/** A picture shown to the model with a tool's result. */
export type ToolImage = {
  data: string;
  mediaType: "image/jpeg" | "image/png" | "image/webp" | "image/gif";
};
export type ToolOutput = string | { text: string; images: ToolImage[] };
export const textOf = (out: ToolOutput) => (typeof out === "string" ? out : out.text);

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e: string) => {
    if (e[0] === "#")
      return String.fromCodePoint(
        e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1)),
      );
    return ENTITIES[e.toLowerCase()] ?? all;
  });
}

export type PluginTool<I = unknown> = {
  /** Starts with the plugin's id and an underscore. */
  name: string;
  description: string;
  schema: z.ZodType<I>;
  /** Sent to the model instead of `schema`'s JSON Schema: for tools defined elsewhere (MCP servers). */
  jsonSchema?: Record<string, unknown>;
  /**
   * A write's policy and the untrusted-content rule apply to it. `own`: one of Hatbot's own features,
   * which runs where it's offered and asks through `call.approve` itself when it must.
   */
  access: "read" | "write" | "own";
  /** Where it's offered; without it, the chat and tasks, and research too for a read. */
  places?: Place[];
  /** Offered in an incognito conversation; without it, a read is. */
  incognito?: boolean;
  /** In the chat, loaded only when the model looks for it, to keep the prompt short. */
  deferred?: boolean;
  /** Offered only when this says so. */
  when?: (o: Offer) => boolean;
  /** Its output isn't cut short. */
  whole?: boolean;
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

/** For a bot deleted while it wrote the reply: what it made would run as nobody's. */
export const BOT_GONE = "Not made: the owner deleted you.";

const ASKED = {
  untrusted: [
    "after reading untrusted content",
    "This conversation has read untrusted content, so changes need your approval.",
  ],
  injection: [
    "after a suspected prompt injection",
    "Something this conversation read may be instructions aimed at a bot, so this needs your approval.",
  ],
} as const;

/** Waits for the owner to approve a change; a refusal, or nowhere to ask, is the tool's error. */
export async function askOwner(
  call: Pick<CallContext, "approve" | "signal">,
  change: { name: string; input: unknown; what: string },
  reason: keyof typeof ASKED,
): Promise<string> {
  const [after, why] = ASKED[reason];
  if (!call.approve)
    throw new PluginError(
      `Not changed: ${after} this needs the owner's approval, which can't be asked here.`,
    );
  const r = await call.approve(
    { tool: change.name, input: change.input, what: change.what, why },
    call.signal,
  );
  if (r.isError) throw new PluginError(r.content);
  return r.content;
}

type ScheduleFields = {
  name?: string;
  prompt?: string;
  enabled?: boolean;
  cron?: string;
  at?: string;
};

/** The `schedules` service: the owner's schedules, changed as the owner would. */
export type SchedulesService = {
  get(id: number): Schedule | null;
  create(input: ScheduleFields & { name: string; prompt: string }, via: "owner"): Schedule;
  update(id: number, patch: ScheduleFields): Schedule | null;
  delete(id: number): boolean;
};

/** The most a file handed to or from Hatbot may be. */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export const sizeText = (n: number) =>
  n >= 1024 * 1024
    ? `${(n / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(n / 1024))} KB`;

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
  prompt?: Partial<Record<Place, string>>;
  /** It gives models: Settings lists them for each role. */
  models?: ModelProvider;
  /** Its lines in Check everything, after its own. */
  checks?: PluginCheck[];
  /** The kinds of background task it starts, by `origin`. */
  origins?: Record<string, TaskOrigin>;
  /** Kinds of background task whose loop it shapes, by name: a task started with `runner` set. */
  runners?: Record<string, TaskRunner>;
  /** Kinds of background task it runs itself, without the model's loop, by the same names. */
  jobs?: Record<string, TaskJob>;
  /** Its own things whose names or instructions have `query` in them, for Search. */
  search?: (query: string) => SearchRoutine[];
};

export type PluginTick = { name: string; everyMs: number; run: () => unknown };

export type PluginPrincipal = { kind: "session" | "token"; id: number };

/** A route sees who's asking in `c.env`: null only on a public route. */
export type PluginEnv = {
  Bindings: {
    principal: PluginPrincipal | null;
    clientIp: string;
    /** For `upgradeWebSocket` from hono/bun, on a path in `sockets`. */
    server?: unknown;
    /** Calls `fn` once the caller signs out or its token is revoked; returns what stops that. */
    onSignOut: (fn: () => void) => () => void;
  };
};

/** A route's :id, as a number. */
export const idParam = (c: { req: { param: (k: string) => string | undefined } }) =>
  Number(c.req.param("id"));

/** It, or a 404 saying it's gone. */
export const found = <T extends object>(
  c: Context,
  x: T | null | undefined,
  gone = "That's gone.",
) => (x ? c.json(x) : c.json({ error: gone }, 404));

/** Under the API's prefix; a PluginError is shown as it is, anything else as "Something went wrong." */
export function pluginRoutes(): Hono<PluginEnv> {
  const app = new Hono<PluginEnv>().basePath(API_PREFIX);
  app.notFound((c) => c.json({ error: "That's gone." }, 404));
  app.onError((err, c) => {
    if (err instanceof PluginError)
      return c.json(
        { error: err.message },
        err.status >= 400 && err.status < 600 ? (err.status as 400) : 400,
      );
    if ("getResponse" in err && typeof err.getResponse === "function")
      return err.getResponse() as Response;
    console.error(err);
    return c.json({ error: "Something went wrong." }, 500);
  });
  return app;
}

export type PluginSignal = { key: string; text: string };

/** A request's JSON body, or a 400 in the API's shape, naming the field that's wrong. */
export async function bodyOf<S extends z.ZodType>(
  c: { req: { json: () => Promise<unknown> } },
  schema: S,
): Promise<z.output<S>> {
  const bad = (error: string, field?: string) =>
    new HTTPException(400, {
      res: Response.json(field ? { error, field } : { error }, { status: 400 }),
    });
  const raw = await c.req.json().catch(() => {
    throw bad("Something in that request isn't right.");
  });
  const r = schema.safeParse(raw);
  if (r.success) return r.data;
  const issue = r.error.issues[0];
  const field = issue?.path.map(String).join(".");
  throw bad(issue?.message ?? "Something in that request isn't right.", field || undefined);
}

/** Whether a call's output is untrusted; without `output`, whether it may be. */
export const untrustedOf = (t: PluginTool, input: unknown, output?: string): boolean =>
  typeof t.untrusted === "function" ? t.untrusted(input, output) : Boolean(t.untrusted);

/** Screenshots kept with the tasks' in the archive, by who took them and when. */
export interface PluginScreens {
  /** Its path, for `read`. */
  save(owner: string, name: string, bytes: Uint8Array): Promise<string>;
  read(path: string): Promise<Uint8Array | null>;
  /** The ones `owner` took from `from` to `to`, in ms. */
  remove(owner: string, from: number, to: number): Promise<void>;
}

export type PluginFiles = {
  attachments: PluginAttachments;
  screens: PluginScreens;
};

/** The core's services a plugin `needs`, each under its name. */
export const hosts = <K extends keyof Hosts>(
  ctx: { service: <T>(name: string) => T },
  names: K[],
) => Object.fromEntries(names.map((n) => [n, ctx.service(n)])) as Pick<Hosts, K>;

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
  /** One named in `uses`, read when called: null while nothing gives it. */
  optional: <T>(name: string) => T | null;
  /** Secrets it keeps by key, out of the database, with Hatbot's own. */
  vault: PluginVault;
  /** Its own small values, kept with Hatbot's settings. */
  store: PluginStore;
  /** Saves values for its `env` variables, as Settings does; plugins reading them restart. */
  saveSecrets: (values: Record<string, string | null>) => Promise<void>;
  /** Where Hatbot is reached, for links and sign-in redirects. */
  publicUrl: string;
  /** For requests out; tests answer them. */
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  /** The time now, in ms; tests move it. */
  clock: () => number;
  /** Another plugin's settings as saved, read when called, even while it's off. */
  configOf: (id: string) => unknown;
  /** Tells the host something happened, as "<id>:<event>". */
  emit: (event: string) => void;
  /** The commit the brain runs, once it was deployed from a release. */
  release: () => string | null;
};

export type PluginVault = {
  get: (key: string) => Record<string, string>;
  /** Each value replaces what's kept; null forgets it. */
  set: (key: string, changes: Record<string, string | null>) => void;
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
  /** Services it uses when something gives them, and does without otherwise. */
  uses?: string[];
  /** Its own tables: each runs once, in order, on every install that has the plugin. */
  migrations?: string[];
  /** Those tables, named "<id>_…": deleting its data drops them. */
  tables?: string[];
  /** Paths under /api/v1 it answers, for signed-in callers: "/boxes" takes /boxes and below. */
  routes?: string[];
  /** Ones anybody may call, as Hono patterns ("/hooks/:name"); the route checks who it is. */
  publicRoutes?: string[];
  /** WebSockets for signed-in callers, as Hono patterns; a browser's must come from Hatbot's address. */
  sockets?: string[];
  start: (ctx: PluginContext<C>) => Promise<PluginInstance> | PluginInstance;
};

export const definePlugin = <C>(p: Plugin<C>) => p as unknown as Plugin;

/** Keeps `extra`'s getters, such as checks made afresh for each run. */
export const ready = (
  tools: PluginTool[],
  extra: Omit<PluginInstance, "status" | "tools"> = {},
): PluginInstance =>
  Object.defineProperties(
    { status: { state: "ready" }, tools } as PluginInstance,
    Object.getOwnPropertyDescriptors(extra),
  );
export const needsSetup = (message: string): PluginInstance => ({
  status: { state: "needs_setup", message },
  tools: [],
});
