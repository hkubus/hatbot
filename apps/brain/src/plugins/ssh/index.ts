// SSH (PLAN.md §5.5, §6.4): run commands on the hosts you list in Settings, as the `hatbot` user, with
// the brain's own key. Host keys are pinned the first time Hatbot connects; a changed key stops it.
// Uses the system's OpenSSH client.
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { allow, ask, definePlugin, PluginError, ready, tool } from "../plugin";
import { destructive } from "./policy";

const OUTPUT_CHARS = 15_000;

const Host = z.object({
  name: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,30}$/, "Lowercase letters, digits and -, e.g. nas")
    .describe("What you and Hatbot call it"),
  address: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.:-]{0,252}$/, "A hostname or IP address"),
  user: z
    .string()
    .regex(/^[a-z_][a-z0-9_-]{0,31}$/, "A Unix user name")
    .default("hatbot"),
  port: z.number().int().min(1).max(65535).default(22),
  /** Every command on it asks you first. */
  careful: z.boolean().default(false),
  /** A Proxmox host with infra/pct-exec-setup.sh run: ssh_pct_exec reaches its containers. */
  proxmox: z.boolean().default(false),
});
type Host = z.infer<typeof Host>;

const Config = z.object({ hosts: z.array(Host).default([]) });

/** Safe looks for the chat: fixed commands, so nothing can change. */
const CHECKS = {
  overview: "uptime; echo; df -h -x tmpfs -x devtmpfs -x overlay; echo; free -m",
  failed: "systemctl --failed --no-pager --plain",
  service: "systemctl status --no-pager --lines=30 -- {unit}",
  logs: "journalctl --no-pager -n 150 -u {unit}",
  errors: "journalctl --no-pager -p err -n 100 --since -1d",
  containers: "docker ps -a --format 'table {{.Names}}\\t{{.Status}}\\t{{.Image}}'",
  ports: "ss -ltnup",
  top: "top -b -n 1 -o %CPU | head -n 25",
} as const;

export type Run = (
  args: string[],
  opts: { timeoutMs: number; signal?: AbortSignal },
) => Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }>;

/** Runs a program and collects its output; kills it on timeout or abort. */
export const spawnRun =
  (bin: string): Run =>
  async (args, { timeoutMs, signal }) => {
    const proc = Bun.spawn([bin, ...args], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? homedir() },
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, timeoutMs);
    const abort = () => proc.kill();
    signal?.addEventListener("abort", abort, { once: true });
    const out = collect(proc.stdout);
    const err = collect(proc.stderr);
    try {
      const code = await proc.exited;
      // Something the command started may still hold the pipes; don't wait on it for long.
      await Promise.race([Promise.all([out.done, err.done]), Bun.sleep(1000)]);
      out.stop();
      err.stop();
      return { code, stdout: out.text(), stderr: err.text(), timedOut };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  };

/** Reads a stream as it comes, so the output so far is there even if it never ends. */
function collect(stream: ReadableStream<Uint8Array>) {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  const done = (async () => {
    for (;;) {
      const r = await reader.read().catch(() => ({ done: true as const, value: undefined }));
      if (r.done) return;
      chunks.push(r.value);
    }
  })();
  return {
    done,
    stop: () => void reader.cancel().catch(() => {}),
    text: () => Buffer.concat(chunks).toString("utf8"),
  };
}

const cut = (s: string) =>
  s.length > OUTPUT_CHARS ? `${s.slice(0, OUTPUT_CHARS)}\n… (cut; ${s.length} characters)` : s;

export const sshPlugin = definePlugin({
  id: "ssh",
  name: "SSH",
  description: "Run commands on your hosts",
  config: Config,
  start: ({ env, config }) => {
    const home = env.HOME ?? homedir();
    const key = env.HATBOT_SSH_KEY ?? join(home, ".ssh/id_ed25519");
    const knownHosts = env.HATBOT_SSH_KNOWN_HOSTS ?? join(home, ".ssh/known_hosts");
    const ssh = spawnRun(env.HATBOT_SSH_BIN ?? "ssh");
    const keygen = spawnRun(env.HATBOT_SSH_KEYGEN_BIN ?? "ssh-keygen");
    const hosts = new Map(config.hosts.map((h) => [h.name, h]));
    const hostNames = config.hosts.map((h) => h.name);
    const pctHosts = config.hosts.filter((h) => h.proxmox).map((h) => h.name);

    const hostOf = (name: string): Host => {
      const h = hosts.get(name);
      if (!h)
        throw new PluginError(
          `"${name}" isn't one of your hosts. Known: ${hostNames.join(", ") || "none"}.`,
        );
      return h;
    };
    const target = (h: Host) => (h.port === 22 ? h.address : `[${h.address}]:${h.port}`);

    /** Runs a command on a host; the result as text for the model. */
    const exec = async (
      h: Host,
      command: string,
      timeoutMs: number,
      signal?: AbortSignal,
    ): Promise<{ text: string; ok: boolean }> => {
      const r = await ssh(
        [
          "-i",
          key,
          "-p",
          String(h.port),
          "-o",
          "BatchMode=yes",
          "-o",
          "IdentitiesOnly=yes",
          "-o",
          "StrictHostKeyChecking=accept-new",
          "-o",
          `UserKnownHostsFile=${knownHosts}`,
          "-o",
          "ConnectTimeout=10",
          "-o",
          "ServerAliveInterval=15",
          "-o",
          "LogLevel=ERROR",
          "-l",
          h.user,
          "--",
          h.address,
          command,
        ],
        { timeoutMs, signal },
      );
      if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/.test(r.stderr))
        throw new PluginError(
          `${h.name}'s host key changed, so Hatbot won't connect: it could be someone else. If the owner rebuilt it, they can forget its key in Settings → Plugins → SSH.`,
        );
      if (r.code === 255 && !r.stdout)
        throw new PluginError(
          `Couldn't connect to ${h.name} (${h.user}@${h.address}): ${r.stderr.trim().slice(0, 300) || "ssh failed"}`,
        );
      const parts = [
        r.timedOut
          ? `Stopped after ${Math.round(timeoutMs / 1000)}s (exit code ${r.code})`
          : `Exit code ${r.code}`,
      ];
      if (r.stdout.trim()) parts.push(cut(r.stdout.trimEnd()));
      if (r.stderr.trim()) parts.push(`stderr:\n${cut(r.stderr.trimEnd())}`);
      return { text: parts.join("\n"), ok: r.code === 0 && !r.timedOut };
    };

    const hostField = z.string().describe(`One of: ${hostNames.join(", ") || "(none yet)"}`);
    const unit = z
      .string()
      .regex(/^[A-Za-z0-9@._:-]{1,100}$/)
      .describe("A systemd unit, e.g. nginx or docker.service");

    const tools = [
      tool({
        name: "ssh_check",
        description: `Look at a host without changing anything: overview (uptime, load, disks, memory), failed (failed systemd units), service (one unit's status, needs unit), logs (a unit's recent journal, needs unit), errors (the last day's errors from the journal), containers (Docker), ports (listening sockets), top (busiest processes). Logs and errors can quote what strangers sent your services: untrusted.`,
        access: "read",
        // Anyone who can reach a service can write into its logs (a request path, a user agent).
        untrusted: ({ what }) => what === "logs" || what === "errors",
        label: "Checking a host",
        schema: z.object({
          host: hostField,
          what: z.enum(Object.keys(CHECKS) as [keyof typeof CHECKS]),
          unit: unit.optional(),
        }),
        describe: ({ host, what, unit }) =>
          `Checked ${what}${unit ? ` of ${unit}` : ""} on ${host}`,
        run: async ({ host, what, unit }, { signal }) => {
          const h = hostOf(host);
          const cmd = CHECKS[what];
          if (cmd.includes("{unit}") && !unit) throw new PluginError(`"${what}" needs a unit.`);
          return (await exec(h, cmd.replace("{unit}", unit ?? ""), 30_000, signal)).text;
        },
      }),
      tool({
        name: "ssh_read_file",
        description:
          "Read a text file on a host (at most 200 KB), e.g. a config file or a log. Use sudo only if the user can't read it. Files can hold text others wrote, such as logs: untrusted.",
        access: "read",
        untrusted: true,
        label: "Reading a file",
        schema: z.object({
          host: hostField,
          path: z.string().regex(/^[~/][^\0\n]*$/, "An absolute path, or one starting with ~/"),
          sudo: z.boolean().optional(),
        }),
        describe: ({ host, path }) => `Read ${path} on ${host}`,
        run: async ({ host, path, sudo }, { signal }) => {
          const h = hostOf(host);
          const cmd = `${sudo ? "sudo -n " : ""}head -c 200000 -- ${shellPath(path)}`;
          return (await exec(h, cmd, 30_000, signal)).text;
        },
      }),
      tool({
        name: "ssh_exec",
        description:
          "Run a shell command on a host and return its exit code and output. Prefer ssh_check for looking around. Destructive commands (deleting data, stopping services, shutting down, changing accounts or the firewall) ask the owner first. Use sudo -n for root; the hatbot user's sudo rules decide what's allowed.",
        access: "write",
        schema: z.object({
          host: hostField,
          command: z.string().min(1).max(10_000),
          timeout_s: z
            .number()
            .int()
            .min(1)
            .max(1800)
            .optional()
            .describe("How long to let it run; default 120"),
        }),
        describe: ({ host, command }) =>
          `On ${host}: ${command.length > 160 ? `${command.slice(0, 160)}…` : command}`,
        policy: ({ host, command }) => {
          const d = destructive(command);
          if (d) return ask(`This command ${d.why}.`, d.kind);
          if (hosts.get(host)?.careful)
            return ask(`The owner asked to approve every command on ${host}.`);
          return allow();
        },
        run: async ({ host, command, timeout_s }, { signal }) =>
          (await exec(hostOf(host), command, (timeout_s ?? 120) * 1000, signal)).text,
      }),
      ...(pctHosts.length
        ? [
            tool({
              name: "ssh_pct_exec",
              description:
                "Run a shell command inside a Proxmox container (LXC), as root in the container, through its Proxmox host. Find the container's ID with proxmox_guests. Hatbot's own brain and desktop are refused. Destructive commands ask the owner first, as with ssh_exec.",
              access: "write",
              schema: z.object({
                host: z.string().describe(`The Proxmox host: ${pctHosts.join(", ")}`),
                guest: z.number().int().min(100).max(999_999_999).describe("The container's ID"),
                command: z.string().min(1).max(10_000),
                timeout_s: z
                  .number()
                  .int()
                  .min(1)
                  .max(1800)
                  .optional()
                  .describe("How long to let it run; default 120"),
              }),
              describe: ({ host, guest, command }) =>
                `In CT ${guest} on ${host}: ${command.length > 160 ? `${command.slice(0, 160)}…` : command}`,
              policy: ({ host, command }) => {
                const d = destructive(command);
                if (d) return ask(`This command ${d.why}.`, d.kind);
                if (hosts.get(host)?.careful)
                  return ask(`The owner asked to approve every command on ${host}.`);
                return allow();
              },
              run: async ({ host, guest, command, timeout_s }, { signal }) => {
                const h = hostOf(host);
                if (!h.proxmox)
                  throw new PluginError(
                    `${host} isn't set up as a Proxmox host. Use: ${pctHosts.join(", ")}.`,
                  );
                const cmd = `sudo -n /usr/local/sbin/hatbot-pct-exec ${guest} ${quote(command)}`;
                return (await exec(h, cmd, (timeout_s ?? 120) * 1000, signal)).text;
              },
            }),
          ]
        : []),
      tool({
        name: "ssh_write_file",
        description:
          "Create or replace a text file on a host with the content you give. Files outside the user's home directory and /tmp ask the owner first.",
        access: "write",
        schema: z.object({
          host: hostField,
          path: z.string().regex(/^[~/][^\0\n]*$/, "An absolute path, or one starting with ~/"),
          content: z.string().max(500_000),
          sudo: z.boolean().optional().describe("Write as root, for files the user can't write"),
        }),
        describe: ({ host, path }) => `Write ${path} on ${host}`,
        policy: ({ host, path, sudo }) => {
          const h = hosts.get(host);
          const mine =
            !sudo &&
            !path.includes("..") &&
            (path.startsWith("~/") ||
              path.startsWith(`/home/${h?.user}/`) ||
              path.startsWith("/tmp/"));
          if (!mine) return ask(`It writes ${path}, outside the hatbot user's own files.`);
          if (/authorized_keys|\/\.ssh\//.test(path))
            return ask("It changes SSH keys.", "account_security");
          if (h?.careful) return ask(`The owner asked to approve every change on ${host}.`);
          return allow();
        },
        run: async ({ host, path, content, sudo }, { signal }) => {
          const h = hostOf(host);
          // The content travels base64-encoded inside the command, so nothing in it is shell syntax.
          const b64 = Buffer.from(content).toString("base64");
          const sh = `${sudo ? "sudo -n " : ""}sh -c ${quote(`mkdir -p -- "$(dirname -- ${shellPath(path)})" && base64 -d > ${shellPath(path)}`)}`;
          const r = await exec(h, `printf %s ${quote(b64)} | ${sh}`, 60_000, signal);
          if (!r.ok) throw new PluginError(`Couldn't write ${path} on ${host}. ${r.text}`);
          return `Wrote ${path} on ${host} (${Buffer.byteLength(content)} bytes).`;
        },
      }),
    ];

    /** Each host's pinned key, if Hatbot has connected before. */
    const pinned = async (h: Host): Promise<string | null> => {
      const r = await keygen(["-F", target(h), "-l", "-f", knownHosts], { timeoutMs: 5000 });
      // "256 SHA256:abc… 192.168.55.10 (ED25519)"
      const line = r.stdout.split("\n").find((l) => l.includes("SHA256:"));
      if (!line) return null;
      return `${/\((\w+)\)/.exec(line)?.[1] ?? "key"} ${/SHA256:\S+/.exec(line)?.[0]}`;
    };

    const actions = {
      /** The key to put in each host's ~hatbot/.ssh/authorized_keys. */
      publicKey: async () => {
        const f = Bun.file(`${key}.pub`);
        if (!(await f.exists()))
          throw new PluginError(`No key at ${key}.pub. infra/brain-provision.sh creates it.`);
        return (await f.text()).trim();
      },
      /** Each host with its pinned key's fingerprint. */
      keys: async () =>
        Promise.all(config.hosts.map(async (h) => ({ name: h.name, key: await pinned(h) }))),
      /** Forgets a host's pinned key; the next connection pins the new one. */
      forget: async (args: unknown) => {
        const { name } = z.object({ name: z.string() }).parse(args);
        const h = hostOf(name);
        await keygen(["-R", target(h), "-f", knownHosts], { timeoutMs: 5000 });
        return { name, key: null };
      },
    };
    if (!hostNames.length)
      return {
        status: { state: "needs_setup", message: "Add the hosts Hatbot may reach." },
        tools: [],
        actions,
      };

    return ready(tools, {
      guidance: hostNames.length
        ? `You can reach these hosts over SSH: ${config.hosts.map((h) => `${h.name} (${h.user}@${h.address}${h.careful ? ", every command asks the owner" : ""})`).join("; ")}. Read memory for what runs where. Look with ssh_check and ssh_read_file; ssh_exec and ssh_write_file change things, and destructive commands ask the owner first. Restarting a service (systemctl restart) runs right away.${pctHosts.length ? ` ${pctHosts.join(" and ")} ${pctHosts.length > 1 ? "are Proxmox hosts" : "is a Proxmox host"}: ssh_pct_exec runs a command inside one of its containers, by ID.` : ""}`
        : undefined,
      test: async () => {
        if (!hostNames.length) throw new PluginError("Add a host first.");
        const lines = await Promise.all(
          config.hosts.map(async (h) => {
            try {
              const r = await exec(h, "hostname", 20_000);
              return `${h.name}: ${r.ok ? "connected" : r.text.split("\n")[0]}`;
            } catch (err) {
              return `${h.name}: ${(err as Error).message}`;
            }
          }),
        );
        return lines.join("\n");
      },
      actions,
    });
  },
});

/** A shell word for a path; ~/ stays unquoted so the remote shell expands it. */
function shellPath(path: string): string {
  return path.startsWith("~/") ? `~/${quote(path.slice(2))}` : quote(path);
}

const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
