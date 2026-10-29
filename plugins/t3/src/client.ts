// T3 Code on the owner's own computer, driven over its MCP endpoint. Everything its agents say is
// untrusted: they read code and pages strangers wrote.

import { PluginError } from "@hatbot/plugin-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export type T3Settings = { url: string; token: string; model: string; minutes: number };

/** One MCP tool call to T3 Code, answering its result as JSON. */
export type T3Caller = (
  tool: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<unknown>;

export type T3Run = {
  /** A T3 project's id, or null for a scratch folder of its own. */
  project: string | null;
  /** A new worktree off this ref; without one, the project's own checkout. */
  base?: string;
  title: string;
  prompt: string;
  /** Carries on in this thread instead of starting one. */
  thread?: string | null;
  signal: AbortSignal;
  onActivity?: (line: string) => void;
  minutes?: number;
};

export type T3Result = {
  /** False when it stopped short and can carry on: out of time, or stopped in T3 Code. */
  ok: boolean;
  /** Its last message, untrusted; or, stopped short, why, in the brain's words. */
  text: string;
  threadId: string;
  minutes: number;
};

export type T3Project = { id: string; title: string; root: string };

/** A failure whose message carries what T3 Code's agent said: untrusted, so it taints what reads it. */
export class T3Error extends PluginError {
  constructor(
    message: string,
    readonly printed = false,
  ) {
    super(message);
  }
}

export const SIGNED_OUT =
  "T3 Code turned Hatbot's sign-in down: connect again on the T3 Code plugin's page.";
const TERMINAL = new Set(["completed", "interrupted", "failed", "cancelled", "rolled_back"]);
const PAGE = 100;

type Fields = Record<string, unknown>;
const fields = (x: unknown): Fields =>
  x && typeof x === "object" && !Array.isArray(x) ? (x as Fields) : {};
const list = (x: unknown) => (Array.isArray(x) ? x.map(fields) : []);
const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : undefined);
const str = (x: unknown) => (typeof x === "string" ? x : undefined);
const oneLine = (s: string, max: number) => {
  const line = s.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** Positions after this one; none given reads from the start, wherever positions start. */
const after = (from: number) => (from > 0 ? { afterPosition: from } : {});

const pause = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });

export function mcpCaller(url: string, token: string): T3Caller & { close: () => Promise<void> } {
  let client: Promise<Client> | null = null;
  const connect = async () => {
    const c = new Client({ name: "hatbot", version: "1.0.0" });
    await c.connect(
      new StreamableHTTPClientTransport(new URL("/mcp", url), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }),
    );
    return c;
  };
  const call: T3Caller = async (tool, args, signal) => {
    try {
      client ??= connect();
      const r = await (await client).callTool({ name: tool, arguments: args }, undefined, {
        signal,
        timeout: 120_000,
      });
      const text = list(r.content)
        .map((c) => str(c.text) ?? "")
        .join("");
      if (r.isError) throw new PluginError(`T3 Code: ${oneLine(text, 300) || "it failed."}`);
      if (r.structuredContent) return r.structuredContent;
      try {
        return JSON.parse(text);
      } catch {
        return {};
      }
    } catch (err) {
      if (signal.aborted) throw signal.reason;
      if (err instanceof PluginError) throw err;
      client?.then((c) => c.close()).catch(() => {});
      client = null;
      const why = err instanceof Error ? err.message : String(err);
      if (/\b401\b|unauthori[sz]ed|invalid_token|invalid_mcp_credential/i.test(why))
        throw new PluginError(SIGNED_OUT);
      throw new PluginError(`T3 Code at ${url} didn't answer: ${oneLine(why, 200)}`);
    }
  };
  return Object.assign(call, {
    close: async () => {
      await client?.then((c) => c.close()).catch(() => {});
      client = null;
    },
  });
}

export class T3Code {
  /** How long one wait for a run lasts before the brain looks at what it did. */
  waitMs = 30_000;
  /** For tests: T3 Code's tools without a server. */
  caller: T3Caller | null = null;
  private settings: T3Settings | null = null;
  private mcp: ReturnType<typeof mcpCaller> | null = null;
  private threads = new Map<string, string>();

  configure(s: T3Settings | null) {
    void this.mcp?.close();
    this.mcp = s ? mcpCaller(s.url, s.token) : null;
    this.settings = s;
  }

  get ready() {
    return this.settings !== null;
  }

  /** The thread a task last worked in, for a project (or "scratch"). */
  last(key: string, project: string): string | null {
    return this.threads.get(`${key}\n${project}`) ?? null;
  }

  /** Its threads stay in T3 Code for the owner to read; the brain only forgets them. */
  forget(key: string) {
    for (const k of this.threads.keys()) if (k.startsWith(`${key}\n`)) this.threads.delete(k);
  }

  remember(key: string, project: string, thread: string) {
    this.threads.set(`${key}\n${project}`, thread);
  }

  private call(tool: string, args: Record<string, unknown>, signal: AbortSignal) {
    const call = this.caller ?? this.mcp;
    if (!call) throw new PluginError("T3 Code is off: switch it on in Settings and connect it.");
    return call(tool, args, signal).then(fields);
  }

  async projects(signal: AbortSignal): Promise<T3Project[]> {
    const out: T3Project[] = [];
    let cursor: number | undefined = 0;
    while (cursor !== undefined && out.length < 1000) {
      const r = await this.call("t3_project_list", { cursor, limit: PAGE }, signal);
      for (const p of list(r.projects)) {
        const id = str(p.id);
        if (id && !p.deletedAt)
          out.push({ id, title: str(p.title) ?? id, root: str(p.workspaceRoot) ?? "" });
      }
      cursor = num(r.nextCursor);
    }
    return out;
  }

  async run(r: T3Run): Promise<T3Result> {
    const s = this.settings;
    if (!s) throw new PluginError("T3 Code is off: switch it on in Settings and connect it.");
    const minutes = r.minutes ?? s.minutes;
    const started = Date.now();
    const took = () => Math.round((Date.now() - started) / 6000) / 10;

    let threadId: string;
    /** The run that was there before this one: a wait that answers it is too early. */
    let before: string | null = null;
    let from = 0;
    let start = 0;
    if (r.thread) {
      threadId = r.thread;
      const now = fields(
        (await this.call("t3_thread_read", { threadId, limit: 1 }, r.signal)).thread,
      );
      before = str(now.latestRunId) ?? null;
      from = num(now.itemCount) ?? 0;
      start = from;
      await this.call("t3_thread_send", { threadId, message: r.prompt, mode: "queue" }, r.signal);
    } else {
      const launched = await this.call(
        "t3_thread_launch",
        {
          title: r.title,
          message: r.prompt,
          ...(r.project
            ? {
                projectId: r.project,
                workspaceStrategy: r.base
                  ? { type: "worktree", baseRef: r.base, startFromOrigin: false }
                  : { type: "root" },
              }
            : { scratch: true }),
          modelSelection: { instanceId: "claudeAgent", model: s.model },
          runtimeMode: "full-access",
          interactionMode: "default",
        },
        r.signal,
      );
      const id = str(launched.threadId) ?? str(fields(launched.thread).threadId);
      if (!id) throw new PluginError("T3 Code didn't say which thread it started.");
      threadId = id;
    }

    const stop = async (why: string) => {
      await this.call(
        "t3_thread_interrupt",
        { threadId, reason: why },
        AbortSignal.timeout(30_000),
      ).catch(() => {});
    };
    const out = (ok: boolean, text: string): T3Result => ({ ok, text, threadId, minutes: took() });
    let runId: string | null = null;
    let status = "";
    try {
      for (;;) {
        const w = await this.call("t3_thread_wait", { threadId, timeoutMs: this.waitMs }, r.signal);
        runId = str(w.runId) ?? null;
        status = str(w.status) ?? "";
        from = await this.activity(threadId, from, r);
        if (runId && runId !== before && TERMINAL.has(status)) break;
        if (status === "waiting")
          return out(
            false,
            "T3 Code is waiting for an answer in its app. Answer it there; then it can carry on.",
          );
        if (Date.now() - started > minutes * 60_000) {
          await stop("Out of time");
          return out(
            false,
            `T3 Code ran out of its ${minutes} minutes and was stopped. It can carry on where it left off.`,
          );
        }
        // A queued message's run hasn't started yet, so the wait answered the one before at once.
        if (w.timedOut !== true) await pause(Math.min(this.waitMs, 2000), r.signal);
        r.signal.throwIfAborted();
      }
    } catch (err) {
      if (r.signal.aborted) {
        await stop("Hatbot's task was stopped");
        throw r.signal.reason;
      }
      throw err;
    }

    const said = await this.lastMessage(threadId, runId, start, r.signal);
    if (status === "completed") return out(true, said);
    if (status === "failed")
      throw new T3Error(
        `T3 Code's run failed${said ? `: ${oneLine(said, 500)}` : "."}`,
        Boolean(said),
      );
    return out(
      false,
      "The run was stopped in T3 Code before it finished. It can carry on where it left off.",
    );
  }

  /** Shows what it's doing as the task's progress; answers where to read from next. */
  private async activity(threadId: string, from: number, r: T3Run): Promise<number> {
    if (!r.onActivity) return from;
    const page = await this.call(
      "t3_thread_read",
      { threadId, view: "activity", ...after(from), limit: PAGE, maxCharsPerItem: 200 },
      r.signal,
    );
    for (const item of list(page.items)) {
      const title = str(item.title);
      if (title && item.createdBy === "agent") r.onActivity(oneLine(title, 80));
    }
    return num(page.nextPosition) ?? from;
  }

  private async lastMessage(
    threadId: string,
    runId: string | null,
    start: number,
    signal: AbortSignal,
  ) {
    let last: Fields | null = null;
    let from = Math.max(0, start - 1);
    for (let pages = 0; pages < 100; pages++) {
      const page = await this.call(
        "t3_thread_read",
        { threadId, view: "messages", ...after(from), limit: PAGE, maxCharsPerItem: 50_000 },
        signal,
      );
      for (const item of list(page.items))
        if (item.type === "assistant_message" && (!runId || item.runId === runId)) last = item;
      const next = num(page.nextPosition);
      if (page.hasMore !== true || next === undefined || next <= from) break;
      from = next;
    }
    if (!last) return "";
    let text = str(last.text) ?? "";
    let offset = last.textTruncated === true ? num(last.nextTextOffset) : undefined;
    const itemId = str(last.itemId);
    // A box's files come back in its last message, up to 2 MB of them.
    while (itemId && offset !== undefined) {
      const more = await this.call(
        "t3_thread_read",
        { threadId, itemId, textOffset: offset, maxCharsPerItem: 50_000 },
        signal,
      );
      const item = list(more.items).find((i) => i.itemId === itemId) ?? fields(more.item);
      const piece = str(item.text) ?? "";
      if (!piece) break;
      text += piece;
      offset = item.textTruncated === true ? num(item.nextTextOffset) : undefined;
    }
    return text;
  }
}

export function runStats(r: T3Result): string {
  return r.minutes < 1 ? "under a minute" : `${Math.round(r.minutes)} min`;
}
