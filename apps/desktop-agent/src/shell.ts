// The desktop's shell (desktop_shell): commands from desktop tasks, run by hatbot-desktop-shell as its own
// systemd DynamicUser. It can't see /home (the browser profile and its logins) or the screen, and it
// holds no secrets: it listens on a Unix socket, which web pages can't reach, and desktop-agent relays.
import { chmodSync, rmSync } from "node:fs";
import type { ShellResult } from "@hatbot/shared/desktop";

export const SHELL_SOCKET = process.env.HATBOT_SHELL_SOCKET ?? "/run/hatbot-shell/shell.sock";
const MAX_OUTPUT = 30_000;
const MAX_TIMEOUT_S = 600;

/** Long output keeps its start and end, where errors and results usually are. */
export function clip(out: string, max = MAX_OUTPUT): string {
  if (out.length <= max) return out;
  const half = Math.floor(max / 2);
  return `${out.slice(0, half)}\n… ${out.length - max} characters left out …\n${out.slice(-half)}`;
}

export async function run(command: string, timeoutS = 60): Promise<ShellResult> {
  const home = process.env.HOME ?? "/tmp";
  const proc = Bun.spawn(["setsid", "bash", "-lc", command], {
    cwd: home,
    // A clean environment: nothing of the service's leaks into commands.
    env: {
      HOME: home,
      USER: "shell",
      PATH: "/usr/local/bin:/usr/bin:/bin",
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

if (import.meta.main) {
  rmSync(SHELL_SOCKET, { force: true });
  Bun.serve({
    unix: SHELL_SOCKET,
    async fetch(req) {
      if (req.method !== "POST" || new URL(req.url).pathname !== "/exec")
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
