// The desktop's shell (desktop_shell): commands from desktop tasks, run by hatbot-desktop-shell as its own
// systemd DynamicUser. It can't see /home (the browser profile and its logins) or the screen, and it
// holds no secrets: it listens on a Unix socket, which web pages can't reach, and desktop-agent relays.
import { chmodSync, rmSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ShellResult } from "@hatbot/shared/desktop";

export const SHELL_SOCKET = process.env.HATBOT_SHELL_SOCKET ?? "/run/hatbot-shell/shell.sock";
const MAX_OUTPUT = 30_000;
const MAX_TIMEOUT_S = 600;
/** The most a file going in or out may be: the brain's attachment limit. */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

/** Long output keeps its start and end, where errors and results usually are. */
export function clip(out: string, max = MAX_OUTPUT): string {
  if (out.length <= max) return out;
  const half = Math.floor(max / 2);
  return `${out.slice(0, half)}\n… ${out.length - max} characters left out …\n${out.slice(-half)}`;
}

export async function run(command: string, timeoutS = 60): Promise<ShellResult> {
  const home = process.env.HOME ?? "/tmp";
  // No profile or rc files: the system's would print banners into the output and change the environment.
  const proc = Bun.spawn(["setsid", "bash", "--noprofile", "--norc", "-c", command], {
    cwd: home,
    // A clean environment: nothing of the service's leaks into commands.
    env: {
      HOME: home,
      USER: "shell",
      // ~/.local/bin for what pip install --user puts there.
      PATH: `${home}/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
      LANG: "C.UTF-8",
      TERM: "dumb",
    },
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

/**
 * A file the brain hands in (PUT) or takes out (GET), relative to the shell's home. It's no boundary:
 * commands can read and write the same files anyway.
 */
export async function file(req: Request, home = process.env.HOME ?? "/tmp"): Promise<Response> {
  const rel = new URL(req.url).searchParams.get("path") ?? "";
  if (!rel || rel.length > 500) return Response.json({ error: "path is missing" }, { status: 400 });
  const path = resolve(home, rel);
  if (req.method === "PUT") {
    const bytes = new Uint8Array(await req.arrayBuffer());
    if (bytes.byteLength > MAX_FILE_BYTES)
      return Response.json({ error: "The file is too big." }, { status: 413 });
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

if (import.meta.main) {
  rmSync(SHELL_SOCKET, { force: true });
  Bun.serve({
    unix: SHELL_SOCKET,
    async fetch(req) {
      const route = new URL(req.url).pathname;
      if (route === "/files" && (req.method === "GET" || req.method === "PUT")) {
        try {
          return await file(req);
        } catch (err) {
          return Response.json({ error: (err as Error).message }, { status: 400 });
        }
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
