// Host keys are pinned the first time Hatbot connects; a changed key stops it.
import { homedir } from "node:os";
import { join } from "node:path";
import { type ApprovalKind, MAX_BOX_VALUE } from "@hatbot/shared";
import { z } from "zod";
import { MAX_ATTACHMENT_BYTES, sizeText } from "../../attachments";
import { type DesktopAgent, DesktopError } from "../../desktop/client";
import {
  allow,
  ask,
  askCareful,
  block,
  definePlugin,
  PluginError,
  ready,
  tool,
  type Verdict,
} from "../plugin";
import { saved } from "../registry";
import { commandCount, destructive, inContainer, readOnly, statusOnly } from "./policy";

const OUTPUT_CHARS = 15_000;
const READ_LINES = 500;

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
  /** Every change on it asks you first. */
  careful: z.boolean().default(false),
  /** A Proxmox host with infra/pct-exec-setup.sh run: ssh_pct_exec reaches its containers. */
  proxmox: z.boolean().default(false),
  /** What its commands, logs and files print is trusted: nobody else writes there. */
  trustOutput: z.boolean().default(false),
});
type Host = z.infer<typeof Host>;

const Config = z.object({ hosts: z.array(Host).default([]) });

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

const KEEP_BYTES = 1024 * 1024;
const FLOOD_BYTES = 256 * 1024 * 1024;
const SSH_OPTIONS =
  "BatchMode=yes IdentitiesOnly=yes StrictHostKeyChecking=accept-new ConnectTimeout=10 ServerAliveInterval=15 LogLevel=ERROR";
/** Printed on the host before the command runs, so a failed command isn't taken for a failed login. */
const CONNECTED = "hatbot-ssh-connected\n";
/** A command's result that holds nothing it printed, only how it ended: nobody else wrote that. */
const silent = (out: string | undefined) =>
  out !== undefined && /^(Exit code -?\d+|Stopped after \d+s \(exit code -?\d+\))$/.test(out);

export type Run = (
  args: string[],
  opts: { timeoutMs: number; signal?: AbortSignal; input?: Uint8Array; keepBytes?: number },
) => Promise<{
  code: number;
  stdout: string;
  /** stdout as it came, for files: its first and last parts if `cut`. */
  bytes: Uint8Array;
  cut: number;
  stderr: string;
  timedOut: boolean;
  flooded: boolean;
}>;

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
 * Reads a stream as it comes, so the output so far is there even if it never ends. Past `keep` bytes
 * only the first and last halves are kept, so a command that writes gigabytes doesn't fill memory.
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
  env: [{ name: "HATBOT_BRAIN_ID", optional: true, hint: "101" }],
  config: Config,
  start: ({ env, config, db, files }) => {
    const home = env.HOME ?? homedir();
    const key = env.HATBOT_SSH_KEY ?? join(home, ".ssh/id_ed25519");
    const knownHosts = env.HATBOT_SSH_KNOWN_HOSTS ?? join(home, ".ssh/known_hosts");
    const ssh = spawnRun(env.HATBOT_SSH_BIN ?? "ssh");
    const keygen = spawnRun(env.HATBOT_SSH_KEYGEN_BIN ?? "ssh-keygen");
    const hosts = new Map(config.hosts.map((h) => [h.name, h]));
    const hostNames = config.hosts.map((h) => h.name);
    // Containers are reached only while the brain knows its own guests' IDs, so it can refuse them
    // here as well as in the host's wrapper.
    const brainId = Number(env.HATBOT_BRAIN_ID) || null;
    const desktopId = Number(env.HATBOT_DESKTOP_ID) || null;
    const marked = config.hosts.filter((h) => h.proxmox).map((h) => h.name);
    const pctHosts = brainId ? marked : [];
    const guestRefused = (guest: number): string | null =>
      !brainId
        ? `Containers are off until HATBOT_BRAIN_ID is set in Settings → Proxmox.`
        : guest === brainId || guest === desktopId
          ? `CT ${guest} is the brain you run on or your desktop; it isn't reached from here.`
          : null;

    const hostOf = (name: string): Host => {
      const h = hosts.get(name);
      if (!h)
        throw new PluginError(
          `"${name}" isn't one of your hosts. Known: ${hostNames.join(", ") || "none"}.`,
        );
      return h;
    };
    const target = (h: Host) => (h.port === 22 ? h.address : `[${h.address}]:${h.port}`);

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
          ...SSH_OPTIONS.split(" ").flatMap((o) => ["-o", o]),
          "-o",
          `UserKnownHostsFile=${knownHosts}`,
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
            `${h.name}'s host key changed, so it isn't connected to: it could be someone else. If the owner rebuilt it, they can forget its key in Settings → Plugins → SSH.`,
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
      const parsed = z
        .object({ careful: z.array(z.number()).default([]) })
        .safeParse(saved(db, "proxmox").config ?? {});
      return parsed.success ? parsed.data.careful : [];
    };

    const placeOf = (r: Remote): Host => {
      const h = hostOf(r.host);
      if (r.guest === undefined) return h;
      if (!h.proxmox)
        throw new PluginError(
          `${r.host} isn't set up as a Proxmox host, so it can't reach CT ${r.guest}. Use: ${pctHosts.join(", ") || "none yet"}.`,
        );
      const refused = guestRefused(r.guest);
      if (refused) throw new PluginError(refused);
      return h;
    };
    const inPlace = (r: Remote, command: string) =>
      r.guest !== undefined
        ? `sudo -n /usr/local/sbin/hatbot-pct-exec ${r.guest} ${quote(command)}`
        : `${r.sudo ? "sudo -n " : ""}sh -c ${quote(command)}`;
    const failed = (
      r: Remote,
      doing: string,
      res: { code: number; stderr: string; timedOut: boolean },
    ) =>
      new PluginError(
        `Couldn't ${doing} ${where(r)}: ${res.stderr.trim().slice(0, 300) || (res.timedOut ? "it took too long" : `exit code ${res.code}`)}`,
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

    const trusts = (host: string) => hosts.get(host)?.trustOutput ?? false;
    const carefulOf = (host: string, guest?: number): string | null =>
      hosts.get(host)?.careful
        ? `The owner asked to approve every change on ${host}.`
        : guest !== undefined && carefulGuests().includes(guest)
          ? `The owner asked to approve every change to CT ${guest}.`
          : null;
    /**
     * A Proxmox host's own commands can reach its careful guests: through the container wrapper, a
     * script that calls it, or a file its shell runs at login. So they are careful too.
     */
    const reachesCareful = (host: string): string | null => {
      if (!hosts.get(host)?.proxmox) return null;
      if (!brainId)
        return `Containers are off until HATBOT_BRAIN_ID is set in Settings → Proxmox, and commands on ${host} can reach them.`;
      const guests = carefulGuests();
      return guests.length
        ? `The owner asked to approve every change to CT ${guests.join(", CT ")}, and commands on ${host} can reach its containers.`
        : null;
    };

    /** Where it's careful, the owner answers whatever the call is; the reason it'd ask still shows. */
    const verdict = (careful: string | null, why: string | null, kind?: ApprovalKind): Verdict =>
      careful
        ? askCareful(why ? `${careful} ${why}` : careful, kind)
        : why
          ? ask(why, kind)
          : allow();

    const writePolicy = (r: Remote): Verdict => {
      const refused = r.guest === undefined ? null : guestRefused(r.guest);
      if (refused) return block(refused);
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
      const careful =
        carefulOf(r.host, r.guest) ?? (r.guest === undefined ? reachesCareful(r.host) : null);
      return verdict(careful, why, kind);
    };

    /** The desktop's sandbox, stopping with the call; what it says when it fails is fine to show. */
    const sandbox = async <T>(
      signal: AbortSignal,
      use: (d: DesktopAgent) => Promise<T>,
    ): Promise<T> => {
      if (!files?.desktop.configured) throw new PluginError("The desktop's sandbox isn't set up.");
      try {
        return await use(files.desktop.withSignal?.(signal) ?? files.desktop);
      } catch (err) {
        throw err instanceof DesktopError ? new PluginError(err.message) : err;
      }
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
        untrusted: ({ host, what }) => !trusts(host) && (what === "logs" || what === "errors"),
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
        description: `Read a text file on a host, e.g. a config file or a log: at most ${READ_LINES} lines and ${OUTPUT_CHARS.toLocaleString("en")} characters a call, from line offset on (1 by default), or its last lines with tail. It says where to read on. In a container on a Proxmox host, give its guest. Use sudo only if the user can't read it. As a box's feed it reads the whole file, or its last lines with tail, up to 1 MB. Files can hold text others wrote, such as logs: untrusted.`,
        access: "read",
        untrusted: ({ host, guest }) => guest !== undefined || !trusts(host),
        label: "Reading a file",
        schema: RemoteFile(hostField).extend({
          offset: z
            .number()
            .int()
            .min(1)
            .max(1_000_000_000)
            .optional()
            .describe("The first line to read; 1 by default"),
          lines: z
            .number()
            .int()
            .min(1)
            .max(1_000_000_000)
            .optional()
            .describe(
              `How many lines; at most ${READ_LINES}, the default. A feed reads every line`,
            ),
          tail: z
            .boolean()
            .optional()
            .describe("Read the last lines instead, e.g. a log's latest; not with offset"),
        }),
        describe: (r) => `Read ${where(r)}`,
        run: async ({ offset, lines, tail, ...r }, { signal, feed }) => {
          if (tail && offset !== undefined)
            throw new PluginError("tail reads the last lines; give it without offset.");
          const h = placeOf(r);
          const path = shellPath(r.path);
          // A feed's result goes to the box's page, not to the model, so it keeps up to its 1 MB.
          const cap = feed ? MAX_BOX_VALUE : OUTPUT_CHARS;
          const sizeOf = (s: string) => (feed ? Buffer.byteLength(s) : s.length);
          const first = offset ?? 1;
          const want = Math.min(lines ?? READ_LINES, READ_LINES);
          // One line or byte more than is kept tells whether there's more; a feed's pipes run only
          // once sed has opened the file, so a missing one fails.
          const cmd = !feed
            ? tail
              ? `sed -n '$=' -- ${path} && tail -n ${want} -- ${path}`
              : `sed -n -e '${first},${first + want}p' -e '${first + want}q' -- ${path}`
            : `sed -n 1q -- ${path} && ${
                tail
                  ? lines
                    ? `tail -n ${lines} -- ${path} | tail -c ${cap + 1}`
                    : `tail -c ${cap + 1} -- ${path}`
                  : `tail -n +${first} -- ${path} | ${lines ? `head -n ${lines} | ` : ""}head -c ${cap + 1}`
              }`;
          const res = await connect(h, inPlace(r, cmd), {
            timeoutMs: 30_000,
            signal,
            keepBytes: feed ? cap + 64 * 1024 : undefined,
          });
          if (res.code !== 0 || res.timedOut) throw failed(r, "read", res);
          const got = res.stdout ? res.stdout.split("\n") : [];
          if (res.stdout.endsWith("\n")) got.pop();
          const over = feed && res.bytes.byteLength > cap;
          const fit = (from: string[]) => {
            const kept: string[] = [];
            let size = 0;
            for (const line of from) {
              if (size + sizeOf(line) > cap) break;
              kept.push(line);
              size += sizeOf(line) + 1;
            }
            return kept;
          };

          if (tail) {
            const total = feed ? 0 : Number(got.shift() ?? 0);
            // Read by bytes from the end, it starts partway through a line.
            if (over) got.shift();
            const shown = fit(got.toReversed()).reverse();
            if (!shown.length) {
              if (!got.length && !over) return feed ? "" : `${r.path} is empty.`;
              if (feed)
                throw new PluginError(`${where(r)}'s last line is over the 1 MB a feed keeps.`);
              return `${(got.at(-1) ?? "").slice(-cap)}\n… (line ${total} is longer than ${OUTPUT_CHARS.toLocaleString("en")} characters; that's its end. Copy the file to the sandbox to read it whole.)`;
            }
            const from = total - shown.length + 1;
            return feed || from <= 1
              ? shown.join("\n")
              : `${shown.join("\n")}\n… (lines ${from} to ${total} of ${total}; read earlier ones with offset)`;
          }

          if (feed) {
            if (over)
              throw new PluginError(
                `${where(r)} is over the 1 MB a feed keeps${first > 1 ? ` from line ${first}` : ""}. Read fewer lines, or its last lines with tail.`,
              );
            return got.join("\n");
          }
          if (!got.length)
            return first === 1 ? `${r.path} is empty.` : `${r.path} has no line ${first}.`;
          const shown = fit(got.slice(0, want));
          if (!shown.length)
            return `${(got[0] ?? "").slice(0, OUTPUT_CHARS)}\n… (line ${first} is longer than ${OUTPUT_CHARS.toLocaleString("en")} characters; that's its start. Read on from line ${first + 1}, or copy the file to the sandbox to read it whole.)`;
          const next = first + shown.length;
          return got.length > shown.length
            ? `${shown.join("\n")}\n… (lines ${first} to ${next - 1}; read on with offset ${next})`
            : shown.join("\n");
        },
      }),
      tool({
        name: "ssh_exec",
        description:
          "Run a shell command on a host and return its exit code and output. Prefer ssh_check for looking around. Commands that look destructive (deleting data, stopping services, shutting down, changing accounts or the firewall) need approval, but that check is a list of patterns and misses things: don't count on it to catch a mistake. Use sudo -n for root; the hatbot user's sudo rules decide what's allowed. In a task, calls for different hosts in the same turn run at once; in the chat, more than two commands go to run_task. Its output is untrusted unless the command only checks status (uptime, df, free, systemctl is-active and the like) or prints nothing, since logs, files and services can carry what strangers wrote.",
        access: "write",
        untrusted: ({ host, command }, out) =>
          !trusts(host) && !statusOnly(command) && !silent(out),
        schema: z.object({
          host: hostField,
          command: z.string().min(1).max(10_000),
          timeout_s: Timeout,
        }),
        describe: ({ host, command }) => `On ${host}: ${command}`,
        target: ({ host }) => host,
        commands: ({ command }) => commandCount(command),
        policy: ({ host, command }) => {
          if (inContainer(command))
            return block(
              "Use ssh_pct_exec to run commands in containers: there each container's own rules apply.",
            );
          const d = destructive(command);
          // A careful host waits for the owner whatever the command; the pattern's reason still shows.
          // On a Proxmox host only a look that writes nothing passes: a file can run later (~/.bashrc).
          const careful = carefulOf(host) ?? (readOnly(command) ? null : reachesCareful(host));
          return verdict(careful, d && `This command ${d.why}.`, d?.kind);
        },
        run: async ({ host, command, timeout_s }, { signal }) =>
          (await exec(hostOf(host), command, (timeout_s ?? 120) * 1000, signal)).text,
      }),
      ...(pctHosts.length
        ? [
            tool({
              name: "ssh_pct_exec",
              description:
                "Run a shell command inside a Proxmox container (LXC), as root in the container, through its Proxmox host. Find the container's ID with proxmox_guests. The brain you run on and your desktop are refused. As with ssh_exec, commands that look destructive need approval, and its output is untrusted unless the command only checks status; in a careful guest, every command waits for the owner. In a task, calls for different containers in the same turn run at once.",
              access: "write",
              untrusted: ({ command }, out) => !statusOnly(command) && !silent(out),
              schema: z.object({
                host: z.string().describe(`The Proxmox host: ${pctHosts.join(", ")}`),
                guest: z.number().int().min(100).max(999_999_999).describe("The container's ID"),
                command: z.string().min(1).max(10_000),
                timeout_s: Timeout,
              }),
              describe: ({ host, guest, command }) => `In CT ${guest} on ${host}: ${command}`,
              // The container's own; its host's commands don't touch it.
              target: ({ host, guest }) => `${host}/${guest}`,
              commands: ({ command }) => commandCount(command),
              policy: ({ host, guest, command }) => {
                const refused = guestRefused(guest);
                if (refused) return block(refused);
                const d = destructive(command, "container");
                // A careful guest is careful about everything, not only power actions.
                return verdict(carefulOf(host, guest), d && `This command ${d.why}.`, d?.kind);
              },
              run: async ({ host, guest, command, timeout_s }, { signal }) => {
                const h = placeOf({ host, guest, path: "/" });
                const cmd = `sudo -n /usr/local/sbin/hatbot-pct-exec ${guest} ${quote(command)}`;
                return (await exec(h, cmd, (timeout_s ?? 120) * 1000, signal)).text;
              },
            }),
          ]
        : []),
      tool({
        name: "ssh_write_file",
        description:
          "Create or replace a text file on a host with the content you give. Files outside the user's home directory and /tmp need approval (the safety review or the owner); SSH keys, and anything on a careful host, wait for the owner.",
        access: "write",
        schema: z.object({
          host: hostField,
          path: remotePath,
          content: z.string().max(500_000),
          sudo: z.boolean().optional().describe("Write as root, for files the user can't write"),
        }),
        describe: ({ host, path }) => `Write ${path} on ${host}`,
        policy: ({ host, path, sudo }) => writePolicy({ host, path, sudo }),
        run: async ({ host, path, content, sudo }, { signal }) => {
          // On stdin, as copies go: in the command it would pass the system's argument limit.
          const bytes = new TextEncoder().encode(content);
          await push({ host, path, sudo }, bytes, signal);
          return `Wrote ${path} on ${host} (${bytes.byteLength} bytes).`;
        },
      }),
      tool({
        name: "ssh_copy_file",
        description: `Copy a file of any kind, up to 25 MB, between your hosts, the containers on a Proxmox host, the desktop's sandbox and the chat. from: a file on a host ({host, path}, plus guest for a container), in the sandbox ({sandbox}), or in the chat ({attachment}: one the owner attached or you sent). to: a host, the sandbox, or the owner ({owner: true}), who gets it under your reply. A path ending in / keeps the file's name. Writing on a host outside the user's home and /tmp needs approval, as with ssh_write_file; in a container, outside /root and /tmp. To look at a text file, ssh_read_file is quicker; copy it to the sandbox to work on it with code_run.`,
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
          let name: string;
          let bytes: Uint8Array;
          if ("host" in from) {
            bytes = await pull(from, signal);
            name = baseName(from.path);
          } else if ("sandbox" in from) {
            bytes = await sandbox(signal, (d) => d.getFile(from.sandbox));
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
            await sandbox(signal, (d) => d.putFile(path, bytes));
            return `Copied ${where(from)} to the sandbox: ${path} (${size}).`;
          }
          const dest = { ...to, path: into(to.path, name) };
          await push(dest, bytes, signal);
          return `Copied ${where(from)} to ${where(dest)} (${size}).`;
        },
      }),
    ];

    const pinned = async (h: Host): Promise<string | null> => {
      const r = await keygen(["-F", target(h), "-l", "-f", knownHosts], { timeoutMs: 5000 });
      // "256 SHA256:abc… 192.168.55.10 (ED25519)"
      const line = r.stdout.split("\n").find((l) => l.includes("SHA256:"));
      if (!line) return null;
      return `${/\((\w+)\)/.exec(line)?.[1] ?? "key"} ${/SHA256:\S+/.exec(line)?.[0]}`;
    };

    const actions = {
      publicKey: async () => {
        const f = Bun.file(`${key}.pub`);
        if (!(await f.exists()))
          throw new PluginError(`No key at ${key}.pub. infra/brain-provision.sh creates it.`);
        return (await f.text()).trim();
      },
      keys: async () =>
        Promise.all(config.hosts.map(async (h) => ({ name: h.name, key: await pinned(h) }))),
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
      guidance: `You can reach these hosts over SSH: ${config.hosts.map((h) => `${h.name} (${h.user}@${h.address}${h.careful ? ", every change asks the owner" : ""})`).join("; ")}. Read memory for what runs where. Look with ssh_check and ssh_read_file; ssh_exec and ssh_write_file change things. Commands that look destructive need approval (the safety review or the owner); a restart (systemctl restart) needs none of its own.${pctHosts.length ? ` ${pctHosts.join(" and ")} ${pctHosts.length > 1 ? "are Proxmox hosts" : "is a Proxmox host"}: ssh_pct_exec runs a command inside one of its containers, by ID. While a container is careful, changes on its host wait for the owner too.` : marked.length ? ` Its containers can't be reached until HATBOT_BRAIN_ID is set in Settings → Proxmox.` : ""} ssh_copy_file moves files between hosts${pctHosts.length ? ", containers" : ""}, the sandbox and the chat: the owner's attachments onto a host, a host's file to the owner or into the sandbox to work on.`,
      test: async () => {
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
        if (marked.length && !brainId)
          lines.push("Containers: off until HATBOT_BRAIN_ID is set in Settings → Proxmox.");
        return lines.join("\n");
      },
      actions,
    });
  },
});

const COPY_TIMEOUT_MS = 5 * 60_000;

const remotePath = z.string().regex(/^[~/][^\0\n]*$/, "An absolute path, or one starting with ~/");
const Timeout = z
  .number()
  .int()
  .min(1)
  .max(1800)
  .optional()
  .describe("How long to let it run; default 120");

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

function where(p: Place): string {
  if ("host" in p)
    return `${p.guest !== undefined ? `CT ${p.guest} on ${p.host}` : p.host}:${p.path}`;
  if ("sandbox" in p) return `the sandbox's ${p.sandbox}`;
  if ("attachment" in p) return `attachment #${p.attachment}`;
  return "the owner";
}

const baseName = (path: string) => path.replace(/\/+$/, "").split("/").pop() || "file";

const into = (path: string, name: string) =>
  path.endsWith("/") ? `${path}${name.replace(/[/\0\n]/g, "_")}` : path;

/** A shell word for a path; ~/ stays unquoted so the remote shell expands it. */
function shellPath(path: string): string {
  return path.startsWith("~/") ? `~/${quote(path.slice(2))}` : quote(path);
}

const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
