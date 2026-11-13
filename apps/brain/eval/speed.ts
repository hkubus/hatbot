// How long tasks and chat replies take against the real API, and where the time goes: the model's
// requests (time to first block, the rest of the stream) and everything else (tools, the brain).
// Three stand-in hosts are a throwaway sshd on 127.0.0.1-3, reached through the real SSH plugin.
//
//   ANTHROPIC_API_KEY=… bun apps/brain/eval/speed.ts [--runs 2] [--only check,chat] [--json out.json] [--instant]
//
// Haiku 5.5 does the work, as by default; a run of every scenario costs a few cents.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { Notifier } from "@hatbot/plugin-sdk";
import { spawn } from "bun";
import { loadConfig } from "../src/config";
import { openDb } from "../src/db";
import { PLUGINS } from "../src/plugins";
import { Secrets } from "../src/secrets";
import { createServices } from "../src/services";

const { values: args } = parseArgs({
  options: {
    runs: { type: "string", default: "2" },
    only: { type: "string" },
    json: { type: "string" },
    model: { type: "string" },
    trace: { type: "boolean" },
    instant: { type: "boolean" },
  },
});
const key = process.env.ANTHROPIC_API_KEY;
if (!key) {
  console.error("Set ANTHROPIC_API_KEY: this runs against the real API.");
  process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), "hatbot-speed-"));

// --- A throwaway sshd on loopback, standing in for three hosts.
const sh = async (cmd: string[]) => {
  const p = spawn(cmd, { stdout: "ignore", stderr: "inherit" });
  if ((await p.exited) !== 0) throw new Error(`${cmd.join(" ")} failed`);
};
await sh(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", join(dir, "host_key")]);
await sh(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", join(dir, "id_ed25519")]);
await Bun.write(join(dir, "authorized_keys"), Bun.file(join(dir, "id_ed25519.pub")));
const port = 20000 + Math.floor(Math.random() * 20000);
const ADDRESSES = ["127.0.0.1", "127.0.0.2", "127.0.0.3"];
writeFileSync(
  join(dir, "sshd_config"),
  `${ADDRESSES.map((a) => `ListenAddress ${a}:${port}`).join("\n")}
HostKey ${join(dir, "host_key")}
AuthorizedKeysFile ${join(dir, "authorized_keys")}
PidFile ${join(dir, "sshd.pid")}
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
StrictModes no
UsePAM no
MaxStartups 50
LogLevel ERROR
`,
);
// Each address answers as a host of its own: its commands print that host's state.
const NAMES = ["nas", "web", "mc"];
/** About how long each takes on a real host, in seconds; --instant leaves it out. */
const RUN_S: Record<string, number> = { top: 0.3, journalctl: 0.25, dpkg: 0.08, systemctl: 0.04 };
const FAKES: Record<string, Record<string, string>> = {
  nas: {
    uptime: " 14:02:11 up 41 days,  3:10,  0 users,  load average: 0.42, 0.37, 0.31",
    df: "Filesystem      Size  Used Avail Use% Mounted on\n/dev/sda2        59G   21G   35G  38% /\ntank            7.2T  6.1T  1.1T  85% /tank",
    free: "               total        used        free      shared  buff/cache   available\nMem:           15890        4120         610          12       11160       11420\nSwap:           4095          80        4015",
    failed: "",
    kernel: "6.12.48+deb13-amd64",
    packages: "612",
    top: "top - 14:02:11 up 41 days,  load average: 0.42, 0.37, 0.31\nTasks: 212 total,   1 running\n%Cpu(s):  3.1 us,  1.2 sy, 95.0 id\n\n    PID USER      PR  NI    VIRT    RES    SHR S  %CPU  %MEM     TIME+ COMMAND\n   1834 root      20   0  412300  98200  10200 S   6.2   0.6 410:11.20 smbd\n    911 root      20   0       0      0      0 S   2.1   0.0  88:02.11 z_wr_iss",
  },
  web: {
    uptime: " 14:02:11 up 6 days, 22:41,  0 users,  load average: 0.08, 0.11, 0.09",
    df: "Filesystem      Size  Used Avail Use% Mounted on\n/dev/vda1        20G  6.6G   13G  35% /",
    free: "               total        used        free      shared  buff/cache   available\nMem:            2048         690         410           8         948        1290\nSwap:            512           0         512",
    failed: "certbot-renew.service loaded failed failed Certbot certificate renewal",
    kernel: "6.12.48+deb13-amd64",
    packages: "438",
    top: "top - 14:02:11 up 6 days,  load average: 0.08, 0.11, 0.09\nTasks: 61 total,   1 running\n%Cpu(s):  1.0 us,  0.7 sy, 98.1 id\n\n    PID USER      PR  NI    VIRT    RES    SHR S  %CPU  %MEM     TIME+ COMMAND\n    602 www-data  20   0   58200  12100   7800 S   0.7   0.6   4:11.02 nginx",
  },
  mc: {
    uptime: " 14:02:11 up 2 days,  1:05,  0 users,  load average: 2.91, 2.70, 2.66",
    df: "Filesystem      Size  Used Avail Use% Mounted on\n/dev/vda1        64G   39G   22G  64% /",
    free: "               total        used        free      shared  buff/cache   available\nMem:           12288        9930         420          16        1938        2040\nSwap:           2048         310        1738",
    failed: "",
    kernel: "6.8.12-4-pve",
    packages: "391",
    top: "top - 14:02:11 up 2 days,  load average: 2.91, 2.70, 2.66\nTasks: 48 total,   1 running\n%Cpu(s): 71.0 us,  2.4 sy, 26.0 id\n\n    PID USER      PR  NI    VIRT    RES    SHR S  %CPU  %MEM     TIME+ COMMAND\n   1201 minecraft 20   0   14.1g   9.1g  21400 S 281.0  74.1   5011:20 java",
  },
};
for (const name of NAMES) {
  const f = FAKES[name] as Record<string, string>;
  const bin = join(dir, "bin", name);
  mkdirSync(bin, { recursive: true });
  const say = (cmd: string, body: string) =>
    writeFileSync(
      join(bin, cmd),
      `#!/bin/sh\n${args.instant ? "" : `sleep ${RUN_S[cmd] ?? 0}\n`}${body}\n`,
      { mode: 0o755 },
    );
  const lines = (s: string | undefined) => `cat <<'EOF'\n${s ?? ""}\nEOF`;
  say("hostname", `echo ${name}`);
  say("uptime", lines(f.uptime));
  say("df", lines(f.df));
  say("free", lines(f.free));
  say("top", lines(f.top));
  say("uname", `case "$1" in -r) echo ${f.kernel} ;; *) echo Linux ;; esac`);
  say(
    "dpkg",
    `i=0; while [ $i -lt ${f.packages} ]; do echo "ii  pkg$i 1.0 amd64 A package"; i=$((i+1)); done`,
  );
  say(
    "systemctl",
    `case "$*" in *--failed*) ${f.failed ? `echo "${f.failed}"` : ":"} ;; *is-active*) echo active ;; *) echo "● $3 - loaded (/lib/systemd/system/$3; enabled)\n   Active: active (running) since Sat 2026-11-07 15:21:02 CET" ;; esac`,
  );
  say(
    "journalctl",
    `echo "Nov 09 03:00:01 ${name} systemd[1]: Starting daily apt upgrade and clean activities..."\necho "Nov 09 03:00:09 ${name} systemd[1]: apt-daily-upgrade.service: Deactivated successfully."`,
  );
}
writeFileSync(
  join(dir, "host"),
  `#!/bin/sh\nPATH=${join(dir, "bin")}/$1:$PATH exec sh -c "$SSH_ORIGINAL_COMMAND"\n`,
  { mode: 0o755 },
);
const matches = ADDRESSES.map(
  (a, i) => `Match LocalAddress ${a}\n  ForceCommand ${join(dir, "host")} ${NAMES[i]}`,
);
writeFileSync(
  join(dir, "sshd_config"),
  `${await Bun.file(join(dir, "sshd_config")).text()}${matches.join("\n")}\n`,
);
mkdirSync("/run/sshd", { recursive: true });
const sshd = spawn(["/usr/sbin/sshd", "-D", "-e", "-f", join(dir, "sshd_config")], {
  stdout: "ignore",
  stderr: "inherit",
});
process.on("exit", () => sshd.kill());
for (let i = 0; i < 100; i++) {
  const up = await Bun.connect({ hostname: "127.0.0.1", port, socket: { data() {} } }).then(
    (s) => {
      s.end();
      return true;
    },
    () => false,
  );
  if (up) break;
  await Bun.sleep(50);
}

// --- Every request to the API, timed from the stream's events.
type Req = {
  kind: string;
  model: string;
  start: number;
  firstBlock: number;
  end: number;
  /** When each tool call's block was complete, before the message ended. */
  toolsDone: number[];
  /** Characters streamed of each kind: thinking, text and tool input. */
  chars: { thinking: number; text: number; tool: number };
  usage: Record<string, number>;
};
const reqs: Req[] = [];
const kindOf = (system: unknown): string => {
  const text = Array.isArray(system)
    ? String((system[0] as { text?: string })?.text ?? "")
    : String(system ?? "");
  if (text.includes("running one background task")) return "task";
  if (text.startsWith("You are Hatbot, a personal assistant that runs")) return "chat";
  if (text.startsWith("You're a helper for Hatbot")) return "helper";
  if (text.startsWith("Hatbot (the owner's assistant")) return "review";
  if (text.startsWith("You maintain a running summary")) return "summary";
  return text.slice(0, 30).replace(/\s+/g, " ") || "other";
};
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!url.includes("api.anthropic.com/v1/messages") || typeof init?.body !== "string")
    return realFetch(input, init);
  const body = JSON.parse(init.body) as { model: string; system?: unknown; stream?: boolean };
  const r: Req = {
    kind: kindOf(body.system),
    model: body.model,
    start: performance.now(),
    firstBlock: 0,
    end: 0,
    toolsDone: [],
    chars: { thinking: 0, text: 0, tool: 0 },
    usage: {},
  };
  reqs.push(r);
  const res = await realFetch(input, init);
  if (!body.stream || !res.body) {
    const json = (await res.clone().json()) as { usage?: Record<string, number> };
    r.firstBlock = r.end = performance.now();
    r.usage = json.usage ?? {};
    return res;
  }
  const [mine, theirs] = res.body.tee();
  void (async () => {
    const decoder = new TextDecoder();
    const blocks = new Map<number, string>();
    let buf = "";
    for await (const chunk of mine) {
      buf += decoder.decode(chunk, { stream: true });
      let at = buf.indexOf("\n");
      while (at >= 0) {
        const line = buf.slice(0, at);
        buf = buf.slice(at + 1);
        at = buf.indexOf("\n");
        if (!line.startsWith("data: ")) continue;
        const e = JSON.parse(line.slice(6)) as {
          type: string;
          index?: number;
          content_block?: { type: string };
          delta?: { type: string; text?: string; thinking?: string; partial_json?: string };
          message?: { usage: Record<string, number> };
          usage?: Record<string, number>;
        };
        if (e.type === "content_block_delta") {
          r.chars.thinking += e.delta?.thinking?.length ?? 0;
          r.chars.text += e.delta?.text?.length ?? 0;
          r.chars.tool += e.delta?.partial_json?.length ?? 0;
        }
        const now = performance.now();
        if (e.type === "message_start") r.usage = { ...e.message?.usage };
        if (e.type === "message_delta") Object.assign(r.usage, e.usage);
        if (e.type === "content_block_start") {
          r.firstBlock ||= now;
          blocks.set(e.index ?? 0, e.content_block?.type ?? "");
        }
        if (e.type === "content_block_stop" && blocks.get(e.index ?? 0) === "tool_use")
          r.toolsDone.push(now);
        if (e.type === "message_stop") r.end = now;
      }
    }
    r.end ||= performance.now();
  })();
  return new Response(theirs, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
}) as typeof fetch;

// --- The brain, with the SSH plugin on the three hosts.
process.env.ANTHROPIC_API_KEY = key;
process.env.HATBOT_SSH_KEY = join(dir, "id_ed25519");
process.env.HATBOT_SSH_KNOWN_HOSTS = join(dir, "known_hosts");
const config = {
  ...loadConfig({ HATBOT_DATA_DIR: dir }),
  updateDir: join(dir, "update"),
  updateRequest: join(dir, "update", "request"),
  releaseFile: join(dir, "release.json"),
};
mkdirSync(config.archiveDir, { recursive: true });
const quiet: Notifier = { send: async () => {} };
const brain = await createServices({
  config,
  db: openDb(config.dbPath),
  notifications: quiet,
  ntfy: null,
  plugins: PLUGINS,
  secrets: new Secrets(join(dir, "secrets.json"), {}),
});
await brain.plugins.startAll();
const HOSTS = NAMES.map((name, i) => ({
  name,
  address: ADDRESSES[i],
  port,
  user: "root",
  trustOutput: true,
}));
await brain.plugins.update("ssh", { enabled: true, config: { hosts: HOSTS } });
brain.settings.update({
  limits: { dailyUsd: 20, monthlyUsd: 10_000 },
  ...(args.model ? { chatModel: args.model, taskModel: args.model } : {}),
});
await brain.memory.write(
  "homelab.md",
  `# Homelab\n\nHosts, all reached over SSH as root:\n- nas: storage, runs Samba.\n- web: nginx and the websites.\n- mc: the Minecraft server.\n`,
  { name: "Owner", email: "owner@local" },
  "Homelab notes",
);

// --- Scenarios.
const until = async <T>(get: () => T | null | undefined, ms = 600_000): Promise<T> => {
  const by = Date.now() + ms;
  for (;;) {
    const v = get();
    if (v) return v;
    if (Date.now() > by) throw new Error("timed out");
    await Bun.sleep(20);
  }
};
const runTask = async (goal: string) => {
  const t = brain.tasks.createBackgroundTask({
    title: goal.slice(0, 60),
    goal,
    origin: "schedule",
    source: "bench",
    runKey: `bench:${Math.random()}`,
  });
  if (!t) throw new Error("the task didn't start");
  const done = await until(() => {
    const now = brain.tasks.get(t.id);
    return now?.finishedAt ? now : null;
  });
  return `${done.status}: ${(done.summary ?? "").slice(0, 160).replace(/\s+/g, " ")}`;
};
const thread = brain.chats.hatbot();
const lastReply = () =>
  brain.db
    .query<{ id: number; text: string; status: string }, [number]>(
      "SELECT id, text, status FROM messages WHERE conversation_id = ? AND role = 'assistant' ORDER BY id DESC LIMIT 1",
    )
    .get(thread.conversationId);
const chat = async (text: string, waitForTask = false) => {
  const before = brain.db.query<{ n: number }, []>("SELECT max(id) AS n FROM tasks").get()?.n ?? 0;
  await thread.post(text).done;
  // The chat may do it itself rather than start one.
  const task = brain.db
    .query<{ id: number }, [number]>("SELECT id FROM tasks WHERE id > ? LIMIT 1")
    .get(before);
  let how = "";
  if (waitForTask && task) {
    await until(() => brain.tasks.get(task.id)?.finishedAt);
    // The chat writes the reply again only when the task notifies; otherwise its summary stands.
    await thread.idle();
    how =
      lastReply()?.text === brain.tasks.get(task.id)?.summary
        ? "[as the task wrote it] "
        : "[written again] ";
  }
  const reply = (lastReply()?.text ?? "").slice(0, 160).replace(/\s+/g, " ");
  await thread.post("/new").done;
  return how + reply;
};

const SCENARIOS: Record<string, () => Promise<string>> = {
  // A look across hosts: ideally one turn of lookups at once, then the result.
  check: () =>
    runTask(
      "Check disk space, memory and failed systemd units on nas, web and mc. Say if anything needs attention.",
    ),
  // Commands on each host, which run at once when called together.
  exec: () =>
    runTask(
      "On each of nas, web and mc, find the kernel version (uname -r) and how many packages are installed (dpkg -l | grep -c ^ii). Report them as a short list.",
    ),
  // A lookup the chat makes itself.
  chat: () => chat("how full is the disk on the nas?"),
  // Work the chat hands to a task, then reports.
  handoff: () =>
    chat(
      "start a task: check the top processes on nas, web and mc and tell me which host is busiest",
      true,
    ),
};

const only = args.only?.split(",");
const runs = Number(args.runs);
type Row = {
  scenario: string;
  run: number;
  wallS: number;
  requests: number;
  modelS: number;
  firstBlockS: number;
  otherS: number;
  /** How long after the first tool call's block was complete the message ended, summed. */
  earlyS: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  byKind: string;
  /** Task replies with no tool call, which only finish_task ends: each costs another request. */
  textOnly: number;
  result: string;
};
const rows: Row[] = [];
const span = (xs: Req[]) => {
  // The union of the requests' times: helpers' requests overlap.
  const sorted = [...xs].sort((a, b) => a.start - b.start);
  let total = 0;
  let from = -1;
  let to = -1;
  for (const r of sorted) {
    if (r.start > to) {
      if (to > from) total += to - from;
      from = r.start;
      to = r.end;
    } else to = Math.max(to, r.end);
  }
  if (to > from) total += to - from;
  return total;
};
for (const [name, run] of Object.entries(SCENARIOS)) {
  if (only && !only.includes(name)) continue;
  for (let i = 0; i < runs; i++) {
    // What the run before left going, such as a summary after /new.
    await until(() => reqs.every((r) => r.end));
    const from = reqs.length;
    const t0 = performance.now();
    let result: string;
    try {
      result = await run();
    } catch (err) {
      result = `error: ${err instanceof Error ? err.message : err}`;
    }
    const wall = performance.now() - t0;
    await Bun.sleep(300);
    const mine = reqs.slice(from).filter((r) => r.start <= t0 + wall);
    const sum = (f: (r: Req) => number) => mine.reduce((n, r) => n + f(r), 0);
    const kinds = new Map<string, number>();
    for (const r of mine) kinds.set(r.kind, (kinds.get(r.kind) ?? 0) + 1);
    const modelMs = span(mine);
    rows.push({
      scenario: name,
      run: i + 1,
      wallS: wall / 1000,
      requests: mine.length,
      modelS: modelMs / 1000,
      firstBlockS: sum((r) => (r.firstBlock || r.end) - r.start) / 1000,
      otherS: (wall - modelMs) / 1000,
      earlyS: sum((r) => (r.toolsDone.length ? r.end - (r.toolsDone[0] as number) : 0)) / 1000,
      input: sum((r) => r.usage.input_tokens ?? 0),
      cacheRead: sum((r) => r.usage.cache_read_input_tokens ?? 0),
      cacheWrite: sum((r) => r.usage.cache_creation_input_tokens ?? 0),
      output: sum((r) => r.usage.output_tokens ?? 0),
      byKind: [...kinds].map(([k, n]) => `${k}×${n}`).join(" "),
      textOnly: mine.filter((r) => r.kind === "task" && !r.toolsDone.length).length,
      result,
    });
    const r = rows.at(-1) as Row;
    console.log(
      `${name.padEnd(8)} #${r.run}  ${r.wallS.toFixed(1).padStart(5)} s  model ${r.modelS.toFixed(1).padStart(5)} s (${String(r.requests).padStart(2)} req, first block ${r.firstBlockS.toFixed(1)} s)  other ${r.otherS.toFixed(1).padStart(4)} s  early ${r.earlyS.toFixed(1)} s  in ${r.input}/${r.cacheRead}/${r.cacheWrite} out ${r.output}  [${r.byKind}]${r.textOnly ? `  text-only ${r.textOnly}` : ""}`,
    );
    console.log(`           ${r.result}`);
    if (args.trace)
      for (const q of mine)
        console.log(
          `             ${q.kind.padEnd(7)} ${((q.start - t0) / 1000).toFixed(2).padStart(6)} → first ${((q.firstBlock - t0) / 1000).toFixed(2).padStart(6)} → end ${((q.end - t0) / 1000).toFixed(2).padStart(6)}  think ${q.chars.thinking} text ${q.chars.text} tools ${q.toolsDone.length} (${q.chars.tool} ch)  in ${q.usage.input_tokens}/${q.usage.cache_read_input_tokens}/${q.usage.cache_creation_input_tokens} out ${q.usage.output_tokens}`,
        );
  }
}
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
for (const name of new Set(rows.map((r) => r.scenario))) {
  const of = rows.filter((r) => r.scenario === name);
  const per = (f: (r: Row) => number) => median(of.map(f)).toFixed(1);
  const textOnly = of.reduce((n, r) => n + r.textOnly, 0);
  console.log(
    `${name.padEnd(8)} median ${per((r) => r.wallS)} s, other ${per((r) => r.otherS)} s, ${per((r) => r.requests)} requests; ${textOnly} text-only in ${of.length} runs`,
  );
}
console.log(`spent $${brain.spend.summary().todayUsd.toFixed(3)}`);
if (args.json) writeFileSync(args.json, JSON.stringify(rows, null, 2));
await brain.plugins.stopAll();
sshd.kill();
rmSync(dir, { recursive: true, force: true });
process.exit(0);
