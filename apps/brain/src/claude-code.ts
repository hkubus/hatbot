// Everything Claude Code says is untrusted: it reads code and pages strangers wrote.
import { type DesktopAgent, DesktopError } from "./desktop/client";
import { PluginError } from "./plugins/plugin";
import { Pool } from "./tasks/lane";

export const CLAUDE = "/usr/local/bin/claude";

export type ClaudeSettings = { token: string; model: string; minutes: number };

export type ClaudeRun = {
  /** Relative to the sandbox's home. */
  dir: string;
  prompt: string;
  system?: string;
  tools: string[];
  /** Bash, among `tools`, runs without asking. */
  bash?: boolean;
  resume?: string | null;
  /** Its home in the sandbox is .claude-runs/<key>: a task's runs share one. */
  key: string;
  signal: AbortSignal;
  onActivity?: (line: string) => void;
  /** Instead of the plugin's settings. */
  model?: string;
  minutes?: number;
};

export type ClaudeResult = {
  /** False when it stopped short and can carry on: out of time or turns, or the desktop restarted. */
  ok: boolean;
  /** Its last message, untrusted; or, stopped short, why, in the brain's words. */
  text: string;
  sessionId: string | null;
  turns: number;
  minutes: number;
  /** What the run would have cost at API prices; the plan pays. */
  costUsd: number;
  /** How much of the plan's 5-hour and weekly limits is used, 0 to 1. */
  usage: { fiveHour?: number; week?: number };
};

/** A failure whose message carries what Claude Code printed: untrusted, so it taints what reads it. */
export class ClaudeCodeError extends PluginError {
  constructor(
    message: string,
    readonly printed = false,
  ) {
    super(message);
  }
}

const SIGNED_OUT =
  "Claude Code isn't signed in: make a new token with `claude setup-token` and set it on the Claude Code plugin's page.";
const NOT_INSTALLED =
  "Claude Code isn't installed on the desktop: run infra/deploy.sh to install it in the sandbox.";
const AUTH = /\b401\b|oauth|not logged in|please log ?in|invalid.*token|authenticat/i;
const MAX_TURNS = 300;

type Fields = Record<string, unknown>;
const fields = (x: unknown): Fields =>
  x && typeof x === "object" && !Array.isArray(x) ? (x as Fields) : {};
const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : undefined);
const str = (x: unknown) => (typeof x === "string" ? x : undefined);
const oneLine = (s: string, max: number) => {
  const line = s.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

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

type Seen = {
  sessionId: string | null;
  result: Fields | null;
  usage: ClaudeResult["usage"];
  authRetry: boolean;
};

export class ClaudeCode {
  pollMs: number;
  private settings: ClaudeSettings | null = null;
  private queue = new Pool(1);
  private runs = 0;
  private sessions = new Map<string, string>();
  private homes = new Set<string>();

  constructor(
    private desktop: DesktopAgent,
    o: { pollMs?: number } = {},
  ) {
    this.pollMs = o.pollMs ?? 2000;
  }

  configure(s: ClaudeSettings | null) {
    this.settings = s;
  }

  get ready() {
    return this.settings !== null && this.desktop.configured;
  }

  last(key: string, dir: string): string | null {
    return this.sessions.get(`${key}\n${dir}`) ?? null;
  }

  async forget(key: string) {
    for (const k of this.sessions.keys()) if (k.startsWith(`${key}\n`)) this.sessions.delete(k);
    if (!this.homes.delete(key)) return;
    try {
      await this.desktop.exec(`rm -rf -- '.claude-runs/${key}'`, 60);
    } catch {
      // The desktop being down leaves a folder in the sandbox; nothing else depends on it.
    }
  }

  async version(): Promise<string> {
    try {
      const r = await this.desktop.exec(`${CLAUDE} --version`, 30);
      if (r.exitCode === 127) throw new PluginError(NOT_INSTALLED);
      if (r.exitCode !== 0)
        throw new PluginError(`claude --version failed: ${oneLine(r.output, 200)}`);
      return r.output.trim();
    } catch (err) {
      if (err instanceof DesktopError) throw new PluginError(err.message);
      throw err;
    }
  }

  async run(r: ClaudeRun): Promise<ClaudeResult> {
    const s = this.settings;
    if (!s)
      throw new PluginError("Claude Code is off: switch it on in Settings and set its token.");
    if (!/^[a-z0-9-]+$/.test(r.key)) throw new Error(`bad Claude Code key: ${r.key}`);
    if (this.runs++ > 0) r.onActivity?.("Waiting for another Claude Code run to end.");
    try {
      await this.queue.acquire(r.signal);
    } catch (err) {
      this.runs--;
      throw err;
    }
    try {
      return await this.once(r, s);
    } finally {
      this.runs--;
      this.queue.release();
    }
  }

  private async once(r: ClaudeRun, s: ClaudeSettings): Promise<ClaudeResult> {
    const minutes = r.minutes ?? s.minutes;
    // The prompt goes first: --tools takes every argument up to the next option.
    const argv = [
      CLAUDE,
      "-p",
      // One that starts with a dash would read as an option.
      r.prompt.startsWith("-") ? ` ${r.prompt}` : r.prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      r.model ?? s.model,
      "--permission-mode",
      "acceptEdits",
      "--permission-prompts",
      "none",
      "--tools",
      r.tools.join(","),
      // Without Bash, --restricted keeps its file tools in its own folder: a box's run can't read the
      // sandbox's other checkouts.
      ...(r.bash ? ["--allowedTools", "Bash"] : ["--restricted"]),
      // No CLAUDE.md, hooks or settings from the folders it works in: those are strangers' too.
      "--setting-sources",
      "",
      "--strict-mcp-config",
      "--max-turns",
      String(MAX_TURNS),
      ...(r.system ? ["--append-system-prompt", r.system] : []),
      ...(r.resume ? ["--resume", r.resume] : []),
    ];
    const desktop = this.desktop.withSignal?.(r.signal) ?? this.desktop;
    const started = Date.now();
    let id: string;
    try {
      id = await desktop.startJob({
        argv,
        cwd: r.dir,
        // The token only ever goes in the job's environment, which no one else's process sees.
        env: {
          CLAUDE_CODE_OAUTH_TOKEN: s.token,
          DISABLE_AUTOUPDATER: "1",
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
          DISABLE_TELEMETRY: "1",
          PATH: "/usr/local/bin:/usr/bin:/bin",
        },
        home: `.claude-runs/${r.key}`,
        timeoutS: minutes * 60,
      });
    } catch (err) {
      if (r.signal.aborted) throw r.signal.reason;
      // A run stopped a moment ago counts against the shell's jobs until its process is gone.
      if (err instanceof DesktopError && err.status === 429)
        throw new PluginError(
          "The desktop is still stopping an earlier Claude Code run; try again in a minute.",
        );
      if (err instanceof DesktopError) throw new PluginError(err.message);
      throw err;
    }
    this.homes.add(r.key);

    const seen: Seen = { sessionId: null, result: null, usage: {}, authRetry: false };
    const read = (line: string) => this.read(line, seen, r);
    /** How it ended; null when the shell restarted under it, which forgets its jobs. */
    let end: { exitCode: number | null; timedOut: boolean; stderr: string } | null = null;
    try {
      let from = 0;
      let rest = "";
      for (;;) {
        const st = await desktop.readJob(id, from);
        // A read gives at most 256 KB: what it printed last may come after the read that says it ended.
        const more = st.next > from;
        from = st.next;
        const lines = (rest + st.output).split("\n");
        rest = lines.pop() ?? "";
        for (const line of lines) read(line);
        if (!st.running && !more) {
          read(rest);
          end = st;
          break;
        }
        if (st.running) await pause(this.pollMs, r.signal);
        r.signal.throwIfAborted();
      }
    } catch (err) {
      if (r.signal.aborted) {
        await this.desktop.stopJob(id).catch(() => {});
        throw r.signal.reason;
      }
      if (!(err instanceof DesktopError)) throw err;
      if (err.status !== 410) throw new PluginError(err.message);
    }

    const res = seen.result;
    const took = (num(res?.duration_ms) ?? Date.now() - started) / 60_000;
    const out = (ok: boolean, text: string): ClaudeResult => ({
      ok,
      text,
      sessionId: seen.sessionId,
      turns: num(res?.num_turns) ?? 0,
      minutes: Math.round(took * 10) / 10,
      costUsd: num(res?.total_cost_usd) ?? 0,
      usage: seen.usage,
    });
    if (!end)
      return out(
        false,
        "The desktop restarted while Claude Code was working, which stopped it. It can carry on where it left off.",
      );
    if (end.timedOut)
      return out(
        false,
        `Claude Code ran out of its ${minutes} minutes and was stopped. It can carry on where it left off.`,
      );
    if (res) {
      const text = str(res.result) ?? "";
      if (res.is_error !== true && res.subtype === "success") return out(true, text);
      const status = num(res.api_error_status);
      if (status === 401 || status === 403 || (status === undefined && AUTH.test(text)))
        throw new ClaudeCodeError(SIGNED_OUT);
      if (res.subtype === "error_max_turns")
        return out(
          false,
          `Claude Code used all its ${MAX_TURNS} turns and stopped. It can carry on where it left off.`,
        );
      const said = oneLine(text, 500);
      throw new ClaudeCodeError(
        `Claude Code stopped with an error: ${said || String(res.subtype)}`,
        Boolean(said),
      );
    }
    if (
      end.exitCode === 127 ||
      /claude: (command )?not found|no such file or directory/i.test(end.stderr)
    )
      throw new ClaudeCodeError(NOT_INSTALLED);
    if (seen.authRetry || AUTH.test(end.stderr)) throw new ClaudeCodeError(SIGNED_OUT);
    const why = oneLine(end.stderr.split("\n").filter(Boolean).slice(-3).join(" "), 300);
    throw new ClaudeCodeError(
      `Claude Code ended without an answer (exit code ${end.exitCode ?? "none"})${why ? `: ${why}` : "."}`,
      Boolean(why),
    );
  }

  private read(line: string, seen: Seen, r: ClaudeRun) {
    if (!line.startsWith("{")) return;
    let m: Fields;
    try {
      m = fields(JSON.parse(line));
    } catch {
      return;
    }
    // Kept at once: a run cut short can carry on from it.
    const session = str(m.session_id);
    if (session && (m.subtype === "init" || m.type === "result")) {
      seen.sessionId = session;
      this.sessions.set(`${r.key}\n${r.dir}`, session);
    }
    if (m.type === "system") {
      if (m.subtype === "api_retry" && num(m.error_status) === 401) seen.authRetry = true;
    } else if (m.type === "rate_limit_event") {
      const windows = fields(fields(m.rate_limit_info).unifiedWindows);
      const fiveHour = num(fields(windows.five_hour).utilization);
      const week = num(fields(windows.seven_day).utilization);
      if (fiveHour !== undefined) seen.usage.fiveHour = fiveHour;
      if (week !== undefined) seen.usage.week = week;
    } else if (m.type === "assistant" && r.onActivity) {
      const content = fields(m.message).content;
      for (const b of Array.isArray(content) ? content.map(fields) : []) {
        if (b.type === "tool_use")
          r.onActivity(activity(str(b.name) ?? "?", fields(b.input), r.dir));
      }
    } else if (m.type === "result") {
      seen.result = m;
    }
  }
}

function activity(name: string, input: Fields, dir: string): string {
  const what =
    str(input.file_path) ??
    str(input.path) ??
    str(input.pattern) ??
    str(input.command) ??
    str(input.description) ??
    "";
  // Paths are absolute in the sandbox; within the folder it works in, they read better without it.
  const at = what.indexOf(`/${dir.replace(/\/$/, "")}/`);
  const short = at >= 0 && name !== "Bash" ? what.slice(at + dir.length + 2) : what;
  return oneLine(name === "Bash" ? `Bash: ${short}` : `${name} ${short}`, 80);
}

export function runStats(r: ClaudeResult): string {
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const plan = [
    r.usage.fiveHour !== undefined && `5-hour ${pct(r.usage.fiveHour)}`,
    r.usage.week !== undefined && `week ${pct(r.usage.week)}`,
  ].filter(Boolean);
  const min = r.minutes < 1 ? "under a minute" : `${Math.round(r.minutes)} min`;
  return `${min}, ${r.turns} turn${r.turns === 1 ? "" : "s"}, worth $${r.costUsd.toFixed(2)} at API prices${plan.length ? `; your plan: ${plan.join(", ")}` : ""}`;
}
