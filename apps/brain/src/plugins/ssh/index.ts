// SSH (PLAN.md §5.5, §6.4): run commands on the hosts you list in Settings, as the `hatbot` user, with
// the brain's own key. Host keys are pinned the first time Hatbot connects; a changed key stops it.
// Uses the system's OpenSSH client.
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { MAX_ATTACHMENT_BYTES, sizeText } from "../../attachments";
import { DesktopError } from "../../desktop/client";
import {
  allow,
  ask,
  askAlways,
  definePlugin,
  PluginError,
  ready,
  tool,
  type Verdict,
} from "../plugin";
import { commandCount, destructive, statusOnly } from "./policy";

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
  // Without its journal lines, which can quote what strangers sent the service: logs shows those.
  service: "systemctl status --no-pager --lines=0 -- {unit}",
  logs: "journalctl --no-pager -n 150 -u {unit}",
  errors: "journalctl --no-pager -p err -n 100 --since -1d",
  containers: "docker ps -a --format 'table {{.Names}}\\t{{.Status}}\\t{{.Image}}'",
  ports: "ss -ltnup",
  top: "top -b -n 1 -o %CPU | head -n 25",
} as const;

/** The most output kept from each stream; past it, its first and last halves. */
const KEEP_BYTES = 1024 * 1024;
/** A command that writes more than this is stopped: nothing useful is that long. */
const FLOOD_BYTES = 256 * 1024 * 1024;
/** Printed on the host before the command runs, so a failed command isn't taken for a failed login. */
const CONNECTED = "hatbot-ssh-connected\n";

export type Run = (
  args: string[],
  /** `input`: what the command reads on stdin. `keepBytes`: the most of stdout kept whole. */
  opts: { timeoutMs: number; signal?: AbortSignal; input?: Uint8Array; keepBytes?: number },
) => Promise<{
  code: number;
  stdout: string;
  /** stdout as it came, for files: its first and last parts if `cut`. */
  bytes: Uint8Array;
  /** How many bytes of stdout were left out of the middle. */
  cut: number;
  stderr: string;
  timedOut: boolean;
  /** Stopped for writing more than FLOOD_BYTES. */
  flooded: boolean;
}>;

/** Runs a program and collects its output; kills it on timeout, abort, or endless output. */
export const spawnRun =
  (bin: string): Run =>
  async (args, { timeoutMs, signal, input, keepBytes = KEEP_BYTES }) => {
    const proc = Bun.spawn([bin, ...args], {
      stdin: input ?? "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? homedir() },
    });
    let timedOut = false;
    let flooded = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, timeoutMs);
    const abort = () => proc.kill();
    signal?.addEventListener("abort", abort, { once: true });
    const flood = () => {
      flooded = true;
      proc.kill();
    };
    const out = collect(proc.stdout, keepBytes, flood);
    const err = collect(proc.stderr, KEEP_BYTES, flood);
    try {
      const code = await proc.exited;
      // Something the command started may still hold the pipes; don't wait on it for long.
      await Promise.race([Promise.all([out.done, err.done]), Bun.sleep(1000)]);
      out.stop();
      err.stop();
      return {
        code,
        stdout: out.text(),
        bytes: out.bytes(),
        cut: out.cut(),
        stderr: err.text(),
        timedOut,
        flooded,
      };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  };

/**
 * Reads a stream as it comes, so the output so far is there even if it never ends. Up to `keep`
 * bytes are kept whole; past that only the first and last halves, so a command that writes
 * gigabytes doesn't fill the brain's memory.
 */
function collect(stream: ReadableStream<Uint8Array>, keep: number, flood: () => void) {
  const half = Math.floor(keep / 2);
  let chunks: Uint8Array[] = [];
  /** Once past `keep`: the first half, and the chunks that hold at least the last half. */
  let head: Buffer | null = null;
  let tail: Uint8Array[] = [];
  let tailBytes = 0;
  let total = 0;
  const reader = stream.getReader();
  const done = (async () => {
    for (;;) {
      const r = await reader.read().catch(() => ({ done: true as const, value: undefined }));
      if (r.done) return;
      total += r.value.byteLength;
      if (total > FLOOD_BYTES) flood();
      if (!head) {
        chunks.push(r.value);
        if (total <= keep) continue;
        const all = Buffer.concat(chunks);
        chunks = [];
        head = all.subarray(0, half);
        tail = [all.subarray(half)];
        tailBytes = all.byteLength - half;
      } else {
        tail.push(r.value);
        tailBytes += r.value.byteLength;
      }
      while (tail.length > 1 && tailBytes - (tail[0]?.byteLength ?? 0) >= half)
        tailBytes -= tail.shift()?.byteLength ?? 0;
    }
  })();
  const last = () => Buffer.concat(tail).subarray(Math.max(0, tailBytes - half));
  const cut = () => (head ? total - head.byteLength - last().byteLength : 0);
  return {
    done,
    stop: () => void reader.cancel().catch(() => {}),
    text: () =>
      head
        ? `${head.toString("utf8")}\n… (${sizeText(cut())} left out) …\n${last().toString("utf8")}`
        : Buffer.concat(chunks).toString("utf8"),
    bytes: () => new Uint8Array(head ? Buffer.concat([head, last()]) : Buffer.concat(chunks)),
    cut,
  };
}

/** Output for the model: long output keeps its start and its end, where errors usually are. */
const cut = (s: string) =>
  s.length > OUTPUT_CHARS
    ? `${s.slice(0, OUTPUT_CHARS - 5000)}\n… (${s.length - OUTPUT_CHARS} characters left out) …\n${s.slice(-5000)}`
    : s;

export const sshPlugin = definePlugin({
  id: "ssh",
  name: "SSH",
  description: "Run commands on your hosts",
  config: Config,
  start: ({ env, config, db, files }) => {
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

    /** Runs a command on a host; throws if it couldn't connect. */
    const connect = async (
      h: Host,
      command: string,
      opts: { timeoutMs: number; signal?: AbortSignal; input?: Uint8Array; keepBytes?: number },
    ) => {
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
          `echo ${CONNECTED.trim()}; ${command}`,
        ],
        opts,
      );
      // Once the marker is there, ssh connected: the command's own errors (and exit code 255) are
      // its own, whatever they say.
      const at = r.stdout.indexOf(CONNECTED);
      if (at < 0) {
        if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/.test(r.stderr))
          throw new PluginError(
            `${h.name}'s host key changed, so Hatbot won't connect: it could be someone else. If the owner rebuilt it, they can forget its key in Settings → Plugins → SSH.`,
          );
        throw new PluginError(
          `Couldn't connect to ${h.name} (${h.user}@${h.address}): ${r.stderr.trim().slice(0, 300) || (r.timedOut ? "it took too long" : "ssh failed")}`,
        );
      }
      const from = Buffer.from(r.bytes.buffer, r.bytes.byteOffset, r.bytes.byteLength).indexOf(
        CONNECTED,
      );
      return {
        ...r,
        stdout: r.stdout.slice(at + CONNECTED.length),
        bytes: r.bytes.subarray(from + CONNECTED.length),
      };
    };

    /** Runs a command on a host; the result as text for the model. */
    const exec = async (
      h: Host,
      command: string,
      timeoutMs: number,
      signal?: AbortSignal,
    ): Promise<{ text: string; ok: boolean }> => {
      const r = await connect(h, command, { timeoutMs, signal });
      const parts = [
        r.flooded
          ? `Stopped: it wrote over ${FLOOD_BYTES / 1024 / 1024} MB (exit code ${r.code})`
          : r.timedOut
            ? `Stopped after ${Math.round(timeoutMs / 1000)}s (exit code ${r.code})`
            : `Exit code ${r.code}`,
      ];
      if (r.stdout.trim()) parts.push(cut(r.stdout.trimEnd()));
      if (r.stderr.trim()) parts.push(`stderr:\n${cut(r.stderr.trimEnd())}`);
      return { text: parts.join("\n"), ok: r.code === 0 && !r.timedOut && !r.flooded };
    };

    /** The Proxmox plugin's guests whose power actions always ask, read live from its settings. */
    const carefulGuests = (): number[] => {
      const row = db
        .query<{ value: string }, [string]>("SELECT value FROM settings WHERE key = ?")
        .get("plugin:proxmox");
      const parsed = z
        .object({ config: z.object({ careful: z.array(z.number()).default([]) }) })
        .safeParse(row ? JSON.parse(row.value) : {});
      return parsed.success ? parsed.data.config.careful : [];
    };

    /** A file's host and path; with `guest`, inside that Proxmox host's container. */
    const placeOf = (r: Remote): Host => {
      const h = hostOf(r.host);
      if (r.guest !== undefined && !h.proxmox)
        throw new PluginError(
          `${r.host} isn't set up as a Proxmox host, so it can't reach CT ${r.guest}. Use: ${pctHosts.join(", ") || "none yet"}.`,
        );
      return h;
    };
    /** A command for the file's place: in the container through its wrapper, or on the host. */
    const inPlace = (r: Remote, command: string) =>
      r.guest !== undefined
        ? `sudo -n /usr/local/sbin/hatbot-pct-exec ${r.guest} ${quote(command)}`
        : `${r.sudo ? "sudo -n " : ""}sh -c ${quote(command)}`;
    const failed = (r: Remote, doing: string, res: { code: number; stderr: string }) =>
      new PluginError(
        `Couldn't ${doing} ${where(r)}: ${res.stderr.trim().slice(0, 300) || `exit code ${res.code}`}`,
      );

    const pull = async (r: Remote, signal: AbortSignal): Promise<Uint8Array> => {
      const h = placeOf(r);
      // One byte past the limit tells a file that's too big from one that just fits.
      const cmd = `head -c ${MAX_ATTACHMENT_BYTES + 1} -- ${shellPath(r.path)}`;
      const res = await connect(h, inPlace(r, cmd), {
        timeoutMs: COPY_TIMEOUT_MS,
        signal,
        // Room for the file whole, and for anything the login prints first.
        keepBytes: MAX_ATTACHMENT_BYTES + 64 * 1024,
      });
      if (res.code !== 0 || res.timedOut) throw failed(r, "read", res);
      if (res.cut || res.bytes.byteLength > MAX_ATTACHMENT_BYTES)
        throw new PluginError(`${where(r)} is over 25 MB.`);
      return res.bytes;
    };

    const push = async (r: Remote, bytes: Uint8Array, signal: AbortSignal) => {
      const h = placeOf(r);
      const p = shellPath(r.path);
      // Written in place, so a file that's there keeps its owner and mode.
      const cmd = `mkdir -p -- "$(dirname -- ${p})" && cat > ${p}`;
      const res = await connect(h, inPlace(r, cmd), {
        timeoutMs: COPY_TIMEOUT_MS,
        signal,
        input: bytes,
      });
      if (res.code !== 0 || res.timedOut) throw failed(r, "write", res);
    };

    /** Why every change there waits for the owner, if it does: a careful host or a careful guest. */
    const carefulOf = (host: string, guest?: number): string | null =>
      hosts.get(host)?.careful
        ? `The owner asked to approve every change on ${host}.`
        : guest !== undefined && carefulGuests().includes(guest)
          ? `The owner asked to approve every change to CT ${guest}.`
          : null;

    /** Writing a file on a host: its own files run, the rest asks. */
    const writePolicy = (r: Remote): Verdict => {
      const h = hosts.get(r.host);
      const inGuest = r.guest !== undefined;
      const home = inGuest ? "/root/" : `/home/${h?.user}/`;
      const mine =
        (inGuest || !r.sudo) &&
        !r.path.includes("..") &&
        (r.path.startsWith("~/") || r.path.startsWith(home) || r.path.startsWith("/tmp/"));
      const keys = /authorized_keys|\/\.ssh\//.test(r.path);
      const why = [
        keys ? "It changes SSH keys." : null,
        mine
          ? null
          : inGuest
            ? `It writes ${r.path} in CT ${r.guest}, outside /root and /tmp.`
            : `It writes ${r.path}, outside the hatbot user's own files.`,
      ]
        .filter(Boolean)
        .join(" ");
      const kind = keys ? "account_security" : undefined;
      const careful = carefulOf(r.host, r.guest);
      if (careful) return askAlways(why ? `${careful} ${why}` : careful, kind);
      return why ? ask(why, kind) : allow();
    };

    const sandbox = () => {
      if (!files?.desktop.configured) throw new PluginError("The desktop's sandbox isn't set up.");
      return files.desktop;
    };

    const hostField = z.string().describe(`One of: ${hostNames.join(", ") || "(none yet)"}`);
    const unit = z
      .string()
      .regex(/^[A-Za-z0-9@._:-]{1,100}$/)
      .describe("A systemd unit, e.g. nginx or docker.service");

    const tools = [
      tool({
        name: "ssh_check",
        description: `Look at a host without changing anything: overview (uptime, load, disks, memory), failed (failed systemd units), service (one unit's status without its log lines, needs unit), logs (a unit's recent journal, needs unit), errors (the last day's errors from the journal), containers (Docker), ports (listening sockets), top (busiest processes). Logs and errors can quote what strangers sent your services: untrusted.`,
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
          "Run a shell command on a host and return its exit code and output. Prefer ssh_check for looking around. Commands that look destructive (deleting data, stopping services, shutting down, changing accounts or the firewall) need approval, but that check is a list of patterns and misses things: don't count on it to catch a mistake. Use sudo -n for root; the hatbot user's sudo rules decide what's allowed. For several hosts, call it once per host in the same turn: they run at once. Its output is untrusted unless the command only checks status (uptime, df, free, systemctl is-active and the like), since logs, files and services can carry what strangers wrote.",
        access: "write",
        untrusted: ({ command }) => !statusOnly(command),
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
        describe: ({ host, command }) => `On ${host}: ${command}`,
        target: ({ host }) => host,
        commands: ({ command }) => commandCount(command),
        policy: ({ host, command }) => {
          const d = destructive(command);
          // A careful host waits for the owner whatever the command; the pattern's reason still shows.
          const careful = carefulOf(host);
          if (careful) return askAlways(d ? `${careful} This command ${d.why}.` : careful, d?.kind);
          return d ? ask(`This command ${d.why}.`, d.kind) : allow();
        },
        run: async ({ host, command, timeout_s }, { signal }) =>
          (await exec(hostOf(host), command, (timeout_s ?? 120) * 1000, signal)).text,
      }),
      ...(pctHosts.length
        ? [
            tool({
              name: "ssh_pct_exec",
              description:
                "Run a shell command inside a Proxmox container (LXC), as root in the container, through its Proxmox host. Find the container's ID with proxmox_guests. Hatbot's own brain and desktop are refused. Destructive commands ask the owner first, and its output is untrusted unless the command only checks status, as with ssh_exec. Calls for different containers in the same turn run at once.",
              access: "write",
              untrusted: ({ command }) => !statusOnly(command),
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
              describe: ({ host, guest, command }) => `In CT ${guest} on ${host}: ${command}`,
              // The container's own; its host's commands don't touch it.
              target: ({ host, guest }) => `${host}/${guest}`,
              commands: ({ command }) => commandCount(command),
              policy: ({ host, guest, command }) => {
                const d = destructive(command, "container");
                // A careful guest is careful about everything, not only power actions.
                const careful = carefulOf(host, guest);
                if (careful)
                  return askAlways(d ? `${careful} This command ${d.why}.` : careful, d?.kind);
                return d ? ask(`This command ${d.why}.`, d.kind) : allow();
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
        policy: ({ host, path, sudo }) => writePolicy({ host, path, sudo }),
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
      tool({
        name: "ssh_copy_file",
        description: `Copy a file of any kind, up to 25 MB, between your hosts, the containers on a Proxmox host, the desktop's sandbox and the chat. from: a file on a host ({host, path}, plus guest for a container), in the sandbox ({sandbox}), or in the chat ({attachment}: one the owner attached or you sent). to: a host, the sandbox, or the owner ({owner: true}), who gets it under your reply. A path ending in / keeps the file's name. Writing on a host outside the user's home and /tmp asks the owner first; in a container, outside /root and /tmp. To look at a text file, ssh_read_file is quicker; copy it to the sandbox to work on it with code_run.`,
        access: "write",
        label: "Copying a file",
        schema: z.object({
          from: z.union([RemoteFile(hostField), SandboxFile, ChatFile]),
          to: z.union([RemoteFile(hostField), SandboxFile, ToOwner]),
        }),
        // Host files can hold what strangers wrote (logs); in the sandbox the model may read them.
        untrusted: ({ from, to }) => "host" in from && "sandbox" in to,
        describe: ({ from, to }) => `Copy ${where(from)} to ${where(to)}`,
        target: ({ to }) =>
          "host" in to ? (to.guest !== undefined ? `${to.host}/${to.guest}` : to.host) : "files",
        // Only a write on a host is a change to the homelab.
        commands: ({ to }) => ("host" in to ? 1 : 0),
        policy: ({ to }) => ("host" in to ? writePolicy(to) : allow()),
        run: async ({ from, to }, { signal, sendFile }) => {
          try {
            let name: string;
            let bytes: Uint8Array;
            if ("host" in from) {
              bytes = await pull(from, signal);
              name = baseName(from.path);
            } else if ("sandbox" in from) {
              bytes = await sandbox().getFile(from.sandbox);
              name = baseName(from.sandbox);
            } else {
              const a = files?.attachments.get(from.attachment);
              const b = a && (await files?.attachments.bytes(a.id));
              if (!a || !b) throw new PluginError(`There's no attachment #${from.attachment}.`);
              name = a.name;
              bytes = b;
            }
            const size = sizeText(bytes.byteLength);
            if ("owner" in to) {
              if (!sendFile) throw new PluginError("Files can't be sent to the owner from here.");
              const a = await sendFile(to.name?.trim() || name, bytes);
              return `Sent "${a.name}" (${a.mediaType}, ${size}) to the owner.`;
            }
            if ("sandbox" in to) {
              const path = into(to.sandbox, name);
              await sandbox().putFile(path, bytes);
              return `Copied ${where(from)} to the sandbox: ${path} (${size}).`;
            }
            const dest = { ...to, path: into(to.path, name) };
            await push(dest, bytes, signal);
            return `Copied ${where(from)} to ${where(dest)} (${size}).`;
          } catch (err) {
            if (err instanceof DesktopError) throw new PluginError(err.message);
            throw err;
          }
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
        ? `You can reach these hosts over SSH: ${config.hosts.map((h) => `${h.name} (${h.user}@${h.address}${h.careful ? ", every command asks the owner" : ""})`).join("; ")}. Read memory for what runs where. Look with ssh_check and ssh_read_file; ssh_exec and ssh_write_file change things, and destructive commands ask the owner first. Restarting a service (systemctl restart) runs right away.${pctHosts.length ? ` ${pctHosts.join(" and ")} ${pctHosts.length > 1 ? "are Proxmox hosts" : "is a Proxmox host"}: ssh_pct_exec runs a command inside one of its containers, by ID.` : ""} ssh_copy_file moves files between hosts${pctHosts.length ? ", containers" : ""}, the sandbox and the chat: the owner's attachments onto a host, a host's file to the owner or into the sandbox to work on.`
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

const COPY_TIMEOUT_MS = 5 * 60_000;

const remotePath = z.string().regex(/^[~/][^\0\n]*$/, "An absolute path, or one starting with ~/");

const RemoteFile = (host: z.ZodString) =>
  z.object({
    host,
    guest: z
      .number()
      .int()
      .min(100)
      .max(999_999_999)
      .optional()
      .describe("A container on that Proxmox host, by ID: the path is inside it"),
    path: remotePath,
    sudo: z.boolean().optional().describe("As root on the host, for files the user can't reach"),
  });
const SandboxFile = z.object({
  sandbox: z
    .string()
    .min(1)
    .max(500)
    .describe('A path in the sandbox, relative to its home as code_run sees it, e.g. "in/"'),
});
const ChatFile = z.object({
  attachment: z.number().int().positive().describe("A file in the chat, by attachment id"),
});
const ToOwner = z.object({
  owner: z.literal(true),
  name: z.string().max(200).optional().describe("The name the owner sees, if not the file's own"),
});

type Remote = { host: string; guest?: number; path: string; sudo?: boolean };
type Place = Remote | { sandbox: string } | { attachment: number } | { owner: true };

/** A place in a few words, for the timeline and approvals. */
function where(p: Place): string {
  if ("host" in p)
    return `${p.guest !== undefined ? `CT ${p.guest} on ${p.host}` : p.host}:${p.path}`;
  if ("sandbox" in p) return `the sandbox's ${p.sandbox}`;
  if ("attachment" in p) return `attachment #${p.attachment}`;
  return "the owner";
}

const baseName = (path: string) => path.replace(/\/+$/, "").split("/").pop() || "file";

/** The destination's path: a directory (ending in /) gets the file's own name. */
const into = (path: string, name: string) =>
  path.endsWith("/") ? `${path}${name.replace(/[/\0\n]/g, "_")}` : path;

/** A shell word for a path; ~/ stays unquoted so the remote shell expands it. */
function shellPath(path: string): string {
  return path.startsWith("~/") ? `~/${quote(path.slice(2))}` : quote(path);
}

const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
