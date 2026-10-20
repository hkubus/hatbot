// The desktop's shell (desktop_shell): commands from desktop tasks, run by hatbot-desktop-shell as its own
// systemd DynamicUser. It can't see /home (the browser profile and its logins) or the screen, and it
// holds no secrets: it listens on a Unix socket, which web pages can't reach, and desktop-agent relays.
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  rmSync,
  statSync,
} from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ShellJob, ShellJobStatus, ShellResult } from "@hatbot/shared/desktop";
import type { Subprocess } from "bun";

export const SHELL_SOCKET = process.env.HATBOT_SHELL_SOCKET ?? "/run/hatbot-shell/shell.sock";
const MAX_OUTPUT = 30_000;
const MAX_TIMEOUT_S = 600;
/** The most a file going in or out may be: the brain's attachment limit. */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
/** A file going in is the biggest body; anything past it is refused before it's read. */
export const MAX_BODY_BYTES = MAX_FILE_BYTES + 64 * 1024;

/** Long output keeps its start and end, where errors and results usually are. */
export function clip(out: string, max = MAX_OUTPUT): string {
  if (out.length <= max) return out;
  const half = Math.floor(max / 2);
  return `${out.slice(0, half)}\n… ${out.length - max} characters left out …\n${out.slice(-half)}`;
}

/** A clean environment: nothing of the service's leaks into commands. */
const cleanEnv = (home: string): Record<string, string> => ({
  HOME: home,
  USER: "shell",
  // ~/.local/bin for what pip install --user puts there.
  PATH: `${home}/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
  LANG: "C.UTF-8",
  TERM: "dumb",
});

export async function run(command: string, timeoutS = 60): Promise<ShellResult> {
  const home = process.env.HOME ?? "/tmp";
  // No profile or rc files: the system's would print banners into the output and change the environment.
  const proc = Bun.spawn(["setsid", "bash", "--noprofile", "--norc", "-c", command], {
    cwd: home,
    env: cleanEnv(home),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timer = setTimeout(
    () => {
      timedOut = true;
      // The whole process group: setsid made the command its leader.
      try {
        process.kill(-proc.pid, "SIGKILL");
      } catch {
        proc.kill("SIGKILL");
      }
    },
    Math.min(MAX_TIMEOUT_S, Math.max(1, timeoutS)) * 1000,
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  const output = [stdout.trimEnd(), stderr.trimEnd() && `[stderr]\n${stderr.trimEnd()}`]
    .filter(Boolean)
    .join("\n");
  return { exitCode, output: clip(output), timedOut };
}

/** A stream's bytes until it ends or passes `max`, and whether it did: what's past that is never read. */
export async function readStream(
  body: ReadableStream<Uint8Array> | null,
  max: number,
): Promise<{ bytes: Uint8Array; over: boolean }> {
  const reader = body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (reader && size <= max) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
  }
  if (size > max) await reader?.cancel().catch(() => {});
  return { bytes: Buffer.concat(chunks), over: size > max };
}

/** The body, or null once it's over `max` bytes: one that says it is isn't read at all. */
export async function readUpTo(req: Request, max: number): Promise<Uint8Array | null> {
  if (Number(req.headers.get("content-length") ?? 0) > max) return null;
  const { bytes, over } = await readStream(req.body, max);
  return over ? null : bytes;
}

/** Where `rel` is, relative to the shell's home ("" for the home itself), or null when it leaves it. */
function inHome(home: string, rel: string): string | null {
  const inside = relative(resolve(home), resolve(home, rel));
  return inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside) ? null : inside;
}

/**
 * A file the brain hands in (PUT) or takes out (GET), relative to the shell's home. It's no boundary:
 * commands can read and write the same files anyway. But a path that leaves home is refused.
 */
export async function file(req: Request, home = process.env.HOME ?? "/tmp"): Promise<Response> {
  const rel = new URL(req.url).searchParams.get("path") ?? "";
  if (!rel || rel.length > 500) return Response.json({ error: "path is missing" }, { status: 400 });
  const path = resolve(home, rel);
  if (!inHome(home, rel))
    return Response.json({ error: `${rel} isn't inside the shell's home.` }, { status: 400 });
  if (req.method === "PUT") {
    const bytes = await readUpTo(req, MAX_FILE_BYTES);
    if (!bytes) return Response.json({ error: "The file is too big." }, { status: 413 });
    await mkdir(dirname(path), { recursive: true });
    await Bun.write(path, bytes);
    return Response.json({ path });
  }
  const f = Bun.file(path);
  if (!(await f.exists()))
    return Response.json({ error: `There's no file at ${rel}.` }, { status: 404 });
  if (f.size > MAX_FILE_BYTES)
    return Response.json({ error: `${rel} is over 25 MB.` }, { status: 413 });
  return new Response(f);
}

/** Jobs' output: the unit's own /tmp (PrivateTmp), gone when it restarts, as the jobs are. */
const JOBS_DIR = process.env.HATBOT_SHELL_JOBS ?? join(tmpdir(), "hatbot-jobs");
const MAX_JOBS = 2;
const MAX_JOB_TIMEOUT_S = 2 * 60 * 60;
/** The most of a job's output one read returns. */
const JOB_READ_BYTES = 256 * 1024;
const JOB_STDERR_BYTES = 4096;
/** From SIGTERM to SIGKILL. */
const KILL_GRACE_MS = 5000;
/** How long a job that ended stays readable when nobody stops it. */
const JOB_KEPT_MS = 60 * 60_000;

type Job = {
  proc: Subprocess;
  out: string;
  err: string;
  ended: boolean;
  /** Stopped or timed out: it has no exit code of its own. */
  killed: boolean;
  timedOut: boolean;
  exitCode: number | null;
  timer?: ReturnType<typeof setTimeout>;
};
const byId = new Map<string, Job>();
/** Jobs whose processes are still there, stopped ones too until they're gone: what MAX_JOBS counts. */
let alive = 0;

/** A signal to a job's whole process group: setsid made it the leader. */
function signal(pid: number, sig: NodeJS.Signals) {
  try {
    process.kill(-pid, sig);
  } catch {}
}

function kill(job: Job) {
  job.killed = true;
  signal(job.proc.pid, "SIGTERM");
  const last = setTimeout(() => signal(job.proc.pid, "SIGKILL"), KILL_GRACE_MS);
  void job.proc.exited.then(() => clearTimeout(last));
}

function forget(id: string) {
  const job = byId.get(id);
  if (!job) return;
  byId.delete(id);
  clearTimeout(job.timer);
  rmSync(job.out, { force: true });
  rmSync(job.err, { force: true });
}

/** Up to `max` bytes of a file from byte `at`, and the file's size. */
function readAt(path: string, at: number, max: number) {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const bytes = Buffer.alloc(Math.max(0, Math.min(max, size - at)));
    return { bytes: bytes.subarray(0, readSync(fd, bytes, 0, bytes.length, at)), size };
  } finally {
    closeSync(fd);
  }
}

function start(body: Partial<ShellJob> | null, home: string): Response {
  const bad = (error: string) => Response.json({ error }, { status: 400 });
  const plain = (s: unknown): s is string => typeof s === "string" && !s.includes("\0");
  const at = (rel: unknown) =>
    plain(rel) && rel && !isAbsolute(rel) && inHome(home, rel) !== null ? resolve(home, rel) : null;
  const { argv, env = {}, timeoutS } = body ?? {};
  if (!Array.isArray(argv) || !argv.length || !argv.every(plain))
    return bad("argv must be a list of strings, the program first.");
  const cwd = at(body?.cwd);
  if (!cwd || !statSync(cwd, { throwIfNoEntry: false })?.isDirectory())
    return bad("cwd must be a folder in the shell's home, by a path relative to it.");
  const jobHome = body?.home === undefined ? home : at(body.home);
  if (!jobHome) return bad("home must be a path in the shell's home, relative to it.");
  if (
    typeof env !== "object" ||
    !env ||
    Array.isArray(env) ||
    Object.entries(env).some(([k, v]) => !/^[A-Z_][A-Z0-9_]*$/.test(k) || k === "HOME" || !plain(v))
  )
    return bad("env must map names in capitals to strings, and can't set HOME.");
  if (typeof timeoutS !== "number" || !Number.isInteger(timeoutS) || timeoutS < 1)
    return bad("timeoutS must be a whole number of seconds.");
  if (timeoutS > MAX_JOB_TIMEOUT_S) return bad("timeoutS can be 2 hours at most.");
  if (alive >= MAX_JOBS)
    return Response.json(
      { error: "Two jobs are running already. Wait for one to end, or stop one." },
      { status: 429 },
    );
  // It persists, so a later job can pick up where this one left off.
  mkdirSync(jobHome, { recursive: true, mode: 0o700 });
  mkdirSync(JOBS_DIR, { recursive: true, mode: 0o700 });
  const id = randomUUID();
  const out = join(JOBS_DIR, `${id}.out`);
  const err = join(JOBS_DIR, `${id}.err`);
  // Files, not pipes: a reader that falls behind never holds the job up.
  const outFd = openSync(out, "w", 0o600);
  const errFd = openSync(err, "w", 0o600);
  let proc: Subprocess;
  try {
    // No shell, and its own process group, so stopping it stops whatever it started too.
    proc = Bun.spawn(["setsid", "--", ...argv], {
      cwd,
      env: { ...cleanEnv(home), HOME: jobHome, ...env },
      stdin: "ignore",
      stdout: outFd,
      stderr: errFd,
    });
  } catch (e) {
    rmSync(out, { force: true });
    rmSync(err, { force: true });
    throw e;
  } finally {
    closeSync(outFd);
    closeSync(errFd);
  }
  const job: Job = { proc, out, err, ended: false, killed: false, timedOut: false, exitCode: null };
  byId.set(id, job);
  alive++;
  job.timer = setTimeout(() => {
    job.timedOut = true;
    kill(job);
  }, timeoutS * 1000);
  void proc.exited.then(() => {
    alive--;
    clearTimeout(job.timer);
    // What it left running in the background goes too: nothing would read or stop it.
    signal(proc.pid, "SIGKILL");
    job.ended = true;
    job.exitCode = job.killed ? null : proc.exitCode;
    if (!byId.has(id)) return;
    job.timer = setTimeout(() => forget(id), JOB_KEPT_MS);
    job.timer.unref();
  });
  return Response.json({ id });
}

function status(job: Job, from: number): ShellJobStatus {
  // Before reading: once it has ended, what's in the file is all there is.
  const running = !job.ended;
  const { bytes, size } = readAt(job.out, from, JOB_READ_BYTES);
  let end = bytes.length;
  // Whole lines while more may come; a full read with no line end goes as it is, so it can't stall.
  if (running || from + end < size) {
    const nl = bytes.lastIndexOf(10);
    if (nl >= 0) end = nl + 1;
    else if (end < JOB_READ_BYTES) end = 0;
  }
  const errSize = running ? 0 : statSync(job.err).size;
  return {
    running,
    exitCode: running ? null : job.exitCode,
    timedOut: job.timedOut,
    output: bytes.subarray(0, end).toString(),
    next: from + end,
    stderr: running
      ? ""
      : readAt(job.err, Math.max(0, errSize - JOB_STDERR_BYTES), JOB_STDERR_BYTES).bytes.toString(),
  };
}

/**
 * Long commands, such as Claude Code at work: POST /jobs starts one, GET /jobs/<id>?from=N reads what
 * it printed as it goes, and DELETE /jobs/<id> stops and forgets it.
 */
export async function jobs(req: Request, home = process.env.HOME ?? "/tmp"): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname === "/jobs" && req.method === "POST")
    return start((await req.json()) as Partial<ShellJob> | null, home);
  if (url.pathname === "/jobs" || (req.method !== "GET" && req.method !== "DELETE"))
    return Response.json({ error: "not found" }, { status: 404 });
  const id = url.pathname.slice("/jobs/".length);
  const job = byId.get(id);
  if (!job) return Response.json({ error: "There's no such job any more." }, { status: 410 });
  if (req.method === "DELETE") {
    if (!job.ended) kill(job);
    forget(id);
    return Response.json({});
  }
  const from = Number(url.searchParams.get("from") ?? 0);
  if (!Number.isSafeInteger(from) || from < 0)
    return Response.json({ error: "from must be a byte offset." }, { status: 400 });
  return Response.json(status(job, from));
}

if (import.meta.main) {
  rmSync(SHELL_SOCKET, { force: true });
  Bun.serve({
    unix: SHELL_SOCKET,
    maxRequestBodySize: MAX_BODY_BYTES,
    async fetch(req) {
      const route = new URL(req.url).pathname;
      try {
        if (route === "/files" && (req.method === "GET" || req.method === "PUT"))
          return await file(req);
        if (route === "/jobs" || route.startsWith("/jobs/")) return await jobs(req);
      } catch (err) {
        return Response.json({ error: (err as Error).message }, { status: 400 });
      }
      if (req.method !== "POST" || route !== "/exec")
        return Response.json({ error: "not found" }, { status: 404 });
      const { command, timeoutS } = (await req.json()) as { command?: unknown; timeoutS?: unknown };
      if (typeof command !== "string" || !command.trim() || command.length > 20_000)
        return Response.json({ error: "command must be a non-empty string" }, { status: 400 });
      return Response.json(await run(command, typeof timeoutS === "number" ? timeoutS : 60));
    },
  });
  // desktop-agent runs as another user.
  chmodSync(SHELL_SOCKET, 0o666);
  console.log(`desktop shell on ${SHELL_SOCKET}`);
}
