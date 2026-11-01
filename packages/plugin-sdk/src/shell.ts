// A pattern list can't prove a command safe; it catches the obvious ways to lose data, lock
// yourself out, or take a host down, and every write still needs approval once a task has read
// untrusted content.
import type { ApprovalKind } from "@hatbot/shared";

const REBOOT = /\breboot\b|\binit\s+6\b/;

/**
 * `host`: only on a host; inside a container, rebooting it is no worse than restarting a service.
 * `unless`: a command it matches that is fine all the same.
 */
type Rule = {
  re: RegExp;
  why: string;
  kind?: ApprovalKind;
  host?: boolean;
  unless?: (command: string) => boolean;
};

const RULES: Rule[] = [
  // Flags can come after the paths too: rm /srv/old -rf.
  {
    re: /\brm\b[^|;&\n]*\s(-(?!-)[a-zA-Z]*[rR]|--recursive\b)/,
    why: "deletes files recursively",
    kind: "delete",
  },
  // rm -f *, which deletes the folder it's run in.
  {
    re: /\brm\s+(-\S*\s+)*\S*(\/\*|\s\/\s*$|\s~\/?\s*$|\*\s*(;|&&|\||&|$))/,
    why: "deletes files",
    kind: "delete",
  },
  {
    re: /\b(shred|wipefs|mkfs(\.\w+)?|mkswap|fdisk|sfdisk|parted|sgdisk|blkdiscard)\b/,
    why: "erases or repartitions a disk",
    kind: "delete",
  },
  { re: /\bdd\b[^|;&]*\bof=/, why: "writes raw data with dd", kind: "delete" },
  {
    re: />\s*\/dev\/(sd|nvme|vd|hd|xvd|mmcblk|disk)/,
    why: "writes to a disk device",
    kind: "delete",
  },
  {
    re: /\b(zfs|zpool)\s+(destroy|rollback|detach|offline|labelclear)\b/,
    why: "destroys or rolls back ZFS data",
    kind: "delete",
  },
  { re: /\b(lvremove|vgremove|pvremove|lvreduce)\b/, why: "removes LVM storage", kind: "delete" },
  { re: /\btruncate\b/, why: "truncates files", kind: "delete" },
  {
    re: /\bfind\b[^|;&\n]*\s(-delete\b|-exec(dir)?\s+(sudo\s+)?(\S*\/)?(rm|shred|unlink)\b)/,
    why: "deletes the files it finds",
    kind: "delete",
  },
  { re: /\bxargs\b[^|;&\n]*\b(rm|shred|unlink|rmdir)\b/, why: "deletes files", kind: "delete" },
  {
    re: /\brsync\b[^|;&\n]*\s--(del\b|delete|remove-source-files)/,
    why: "deletes files with rsync",
    kind: "delete",
  },
  {
    re: /\b(pct|qm)\s+(destroy|stop|shutdown|rollback|delsnapshot|reset|suspend)\b/,
    why: "destroys or stops a guest",
    kind: "delete",
  },
  { re: /\bpvesh\s+delete\b/, why: "deletes something in Proxmox", kind: "delete" },
  { re: /\bpvesm\s+(free|remove)\b/, why: "deletes Proxmox storage", kind: "delete" },
  {
    re: /\bpvesh\s+(create|set)\b[^|;&\n]*\/status\/(stop|shutdown|suspend|reboot)\b/,
    why: "stops or reboots a guest",
  },
  { re: /\b(shutdown|poweroff|halt)\b|\binit\s+0\b/, why: "shuts down {where}" },
  {
    re: /\bsystemctl\s+(\S+\s+)*(poweroff|halt|kexec|rescue|emergency|isolate)\b/,
    why: "shuts down {where}",
  },
  // proxmox_power reboots a guest with the brain, the desktop and careful guests checked.
  { re: /\b(pct|qm)\s+reboot\b/, why: "reboots a guest" },
  { re: REBOOT, why: "reboots the host", host: true },
  {
    re: /\bsystemctl\s+(\S+\s+)*(stop|disable|mask|kill)\b|\bservice\s+\S+\s+stop\b|\binit\.d\/\S+\s+stop\b/,
    why: "stops or disables a service",
  },
  // Options can come first: docker compose -f app.yml down -v, docker -H … rm -f web.
  {
    re: /\b(docker|podman)(-compose)?\b[^|;&\n]*\s(rm|rmi|down|kill|prune)\b/,
    why: "removes Docker containers, images or volumes",
    kind: "delete",
  },
  {
    re: /\b(docker|podman)(-compose)?\b[^|;&\n]*\s(stop|pause)\b/,
    why: "stops Docker containers",
  },
  {
    re: /\b(apt|apt-get|dpkg|dnf|yum|pacman|apk)\b[^|;&]*\s(remove|purge|autoremove|erase|del|-R\w*|-r)\b/,
    why: "uninstalls packages",
    kind: "delete",
  },
  { re: /\b(userdel|groupdel|deluser|delgroup)\b/, why: "deletes accounts", kind: "delete" },
  {
    re: /\b(passwd|chpasswd|usermod|chage|visudo|useradd|adduser|groupadd|addgroup|gpasswd)\b|authorized_keys|\.ssh\/|\/etc\/(sudoers|shadow|passwd)\b|\bssh-keygen\b|\bpveum\b[^|;&\n]*\s(add|modify|delete|remove|passwd)\b/,
    why: "changes accounts, passwords or keys",
    kind: "account_security",
    unless: (command) => readsAccounts(command),
  },
  { re: /\b(chmod|chown|chgrp)\s+(-\S*\s+)*-\S*R/, why: "changes permissions recursively" },
  {
    re: /\b(iptables|ip6tables)(-legacy|-nft)?\b[^|;&\n]*\s(-[AIDRPFX]\b|--(append|insert|delete|replace|policy|flush|delete-chain)\b)|\b(iptables|ip6tables)(-legacy|-nft)?-restore\b|\bnft\b[^|;&\n]*\s(add|insert|delete|flush|replace|destroy|-f)\b|\bufw\s+(--?\S+\s+)*(allow|deny|reject|limit|delete|insert|prepend|disable|enable|reset|default|route|reload)\b/,
    why: "changes the firewall",
  },
  // Options can come before the object (ip -4 addr flush), and ip takes abbreviations (ip a flush).
  {
    re: /\bip\s+(-\S+\s+)*(l|link)\s+set\b[^|;&\n]*\sdown\b|\bip\s+(-\S+\s+)*(a|addr|address|r|ro|route|n|neigh)\s+([^\s|;&]+\s+)*?(del|delete|flush)\b|\b(ifdown|nmcli\s+\S+\s+(down|delete))\b/,
    why: "takes the network down",
  },
  { re: /\bcrontab\s+(-\S*\s+)*-r\b/, why: "deletes a crontab", kind: "delete" },
  {
    // + and : refspecs force-push and delete: git push origin +main, git push origin :main.
    re: /\bgit\s+(push\b[^|;&\n]*\s(-f\b|--force|--mirror|--delete|-d\b|\+\S|:\S)|reset\s+--hard|clean\s+-\S*f|branch\s+-D)/,
    why: "rewrites or discards git history",
    kind: "delete",
  },
  // | /bin/sh, | busybox sh, | env sh.
  {
    re: /\|\s*((sudo|env|busybox|nice|nohup|exec|command|timeout\s+\S+)\s+(-\S+\s+)*)*(\S*\/)?((ba|z|da|k|a)?sh|python[\d.]*|perl|ruby|node)\b/,
    why: "runs what it reads as a script",
  },
  // bash -c "$(echo … | base64 -d)", eval "$(…)".
  {
    re: /\b((ba|z|da|k|a)?sh\s+(-\S+\s+)*-\S*c\s+["']?|eval\s+["']?)(\$\(|`)/,
    why: "runs a script it builds as it goes",
  },
  // bash <(curl …), sh -c "$(curl …)", source <(wget …)
  {
    re: /[<$]\(\s*(sudo\s+)?(curl|wget)\b/,
    why: "runs a script straight from the internet",
  },
  // find . -exec sh -c '…', find . -exec busybox rm {} +, xargs busybox rm.
  {
    re: /\bfind\b[^|;&\n]*\s-exec(dir)?\s+(sudo\s+)?\S*(sh|bash|zsh|dash|python[\d.]*|perl|ruby|node)\b/,
    why: "runs a shell on what it finds",
  },
  {
    re: /\bfind\b[^|;&\n]*\s-exec(dir)?\s+((sudo|busybox|nice|env|nohup|ionice|timeout)\s+)*(\S*\/)?(rm|shred|unlink|rmdir)\b/,
    why: "deletes the files it finds",
    kind: "delete",
  },
  {
    re: /\bxargs\b[^|;&\n]*\b((sudo|busybox|nice|env|nohup|ionice|timeout)\s+)*(\S*\/)?(rm|shred|unlink|rmdir)\b/,
    why: "deletes files",
    kind: "delete",
  },
  // install -m 4755 bash /tmp/x, --mode=u+s: setuid or setgid, or a program put on root's PATH.
  {
    re: /\binstall\b[^|;&\n]*\s(-m\s*|--mode[=\s]\s*)(0?[2-7][0-7]{3}\b|\S*s)|\binstall\b[^|;&\n]*\s\S*\/usr\/local\/(s?bin)\//,
    why: "installs a program that runs with privileges of its own",
    kind: "other",
  },
  // Writes to a system file, which changes what the machine does: printed out, tee'd, edited in place
  // with sed or perl, or any of those from inside a system folder (cd /etc && echo x > hosts).
  {
    re: />>?\s*(?!\/dev\/)\/(etc|boot|usr|lib|lib64|sbin|bin|opt|var\/spool\/cron)\/|\btee\b[^|;&\n]*\s(-a\s+)?\/(etc|boot|usr|lib|sbin|bin|var\/spool\/cron)\/|\b(sed|perl)\b[^|;&\n]*\s(-[^-\s]*i\S*|--in-place\S*)\s[^|;&\n]*\/(etc|boot|usr|lib|sbin|bin|var\/spool\/cron)\/|\bcd\s+["']?\/(etc|boot|usr|lib|lib64|sbin|bin|opt|var\/spool\/cron)\b[^\n]*(>>?\s*[^\s&/]|\btee\s+(-a\s+)?[^\s/-]|\b(sed|perl)\b[^|;&\n]*\s(-[^-\s]*i|--in-place))/,
    why: "changes a system file",
  },
  {
    re: /\bkill(all)?\s+(-9\s+|-KILL\s+)?(-1|1)\b|\bpkill\s+(-9\s+)?(systemd|sshd|init)\b/,
    why: "kills essential processes",
  },
  { re: /\b(killall|pkill)\b/, why: "kills processes by name" },
  { re: /:\(\)\s*\{/, why: "looks like a fork bomb" },
  { re: /\bmv\s+[^|;&]*\s(\/dev\/null|\/)\s*$/, why: "moves files away for good", kind: "delete" },
];

export function commandCount(command: string): number {
  if (
    /\b(for|while|until)\b[\s\S]*\bdo\b|\b(xargs|parallel)\b|\bfind\b[^|;&]*\s-exec/.test(command)
  )
    return Number.POSITIVE_INFINITY;
  return Math.max(1, command.split(/;|&&|\|\||\n/).filter((part) => part.trim()).length);
}

/** `where`: "container" for ssh_pct_exec. */
export function destructive(
  command: string,
  where: "host" | "container" = "host",
): { why: string; kind: ApprovalKind } | null {
  for (const r of RULES)
    if (!(r.host && where === "container") && r.re.test(command) && !r.unless?.(command))
      return { why: r.why.replace("{where}", `the ${where}`), kind: r.kind ?? "other" };
  return null;
}

/** Commands that only read accounts and public keys: getent passwd, cat ~/.ssh/authorized_keys. */
const ACCOUNT_READERS = new Set([
  "cat",
  "head",
  "tail",
  "grep",
  "wc",
  "ls",
  "stat",
  "getent",
  "id",
  "groups",
  "cut",
  "sort",
  "uniq",
]);
/** What isn't read without the owner: shadow files and private keys. */
const SECRET = /shadow|(^|\/)id_[\w-]+$|_key$|\.(pem|key|p12|pfx|ppk)$/;

function readsAccounts(command: string): boolean {
  const parsed = pipelines(command);
  if (!parsed?.lines.length || parsed.files.some((f) => f !== "/dev/null")) return false;
  return parsed.lines.every((p) =>
    p.every((words) => {
      const [prog = "", ...args] = plain(words);
      const name = prog.split("/").pop() ?? "";
      if (args.some((a) => SECRET.test(a))) return false;
      if (name === "ssh-keygen")
        return args.every((a) => !a.startsWith("-") || /^-[lfvEF]+$/.test(a));
      // A recursive grep reads the private keys beside the public ones.
      if (name === "grep" && args.some((a) => /^-[^-]*[rR]|^--(rec|deref)/.test(a))) return false;
      return ACCOUNT_READERS.has(name) && !changes([name, ...args]);
    }),
  );
}

/** Commands that read and change nothing, and the subcommands allowed (null: any). */
const READERS: Record<string, string[] | null> = {
  cat: null,
  head: null,
  tail: null,
  grep: null,
  wc: null,
  ls: null,
  stat: null,
  du: null,
  cut: null,
  sort: null,
  getent: null,
  ps: null,
  ss: null,
  pveversion: null,
  journalctl: null,
  dmesg: null,
  date: null,
  df: null,
  ip: ["a", "addr", "address", "r", "ro", "route", "l", "link", "n", "neigh"],
  pct: ["list", "status", "config", "listsnapshot", "df", "pending"],
  qm: ["list", "status", "config", "listsnapshot", "pending"],
  pvesh: ["get", "ls"],
  pvesm: ["status", "list"],
  pvecm: ["status", "nodes"],
  zpool: ["list", "status", "iostat"],
  zfs: ["list", "get"],
  docker: ["ps", "logs", "inspect", "images", "stats"],
  systemctl: [
    "",
    "status",
    "show",
    "cat",
    "list-units",
    "list-timers",
    "is-active",
    "is-enabled",
    "is-failed",
    "is-system-running",
  ],
};
/**
 * A reader's options that change something: journalctl's maintenance, dmesg clearing the buffer or
 * switching console logging, date setting the clock, ss killing sockets.
 */
const WRITES: Record<string, RegExp> = {
  journalctl: /^--(rotate|vacuum|flush|sync|relinquish|setup-keys|update-catalog)/,
  dmesg: /^-[^-]*[cCDEn]|^--(clear|read-clear|console)/,
  date: /^-[^-]*s|^--set/,
  ss: /^-[^-]*K|^--kill/,
};

/** On a Proxmox host this may run while a container is careful: it can't reach one to change it. */
export function readOnly(command: string): boolean {
  if (statusOnly(command, { writes: false })) return true;
  const parsed = pipelines(command);
  if (!parsed?.lines.length || parsed.files.some((f) => f !== "/dev/null")) return false;
  return parsed.lines.every((p) =>
    p.every((words, i) => {
      const w = plain(words);
      if (i > 0 && isFilter(w)) return true;
      const [prog = "", ...args] = w;
      const name = prog.split("/").pop() ?? "";
      const subs = READERS[name];
      if (subs === undefined || changes(w)) return false;
      const writes = WRITES[name];
      if (writes && args.some((a) => writes.test(a))) return false;
      if (subs === null) return true;
      return subs.includes(args.find((a) => !a.startsWith("-")) ?? "");
    }),
  );
}

/**
 * Catches the container wrapper, pct exec and lxc-attach even through quotes, escapes, variables or
 * globs (hatbot-$p-exec). A name built some other way still gets past this, so a careful guest's safety
 * is its host being marked "Proxmox host", where every change asks.
 */
export function inContainer(command: string): boolean {
  const bare = command.replace(/\$\([^)]*\)|`[^`]*`|\$\{[^}]*\}|\$\w+|['"\\]/g, "");
  return /hatbot-\S*exec|pct-exec|\bpct\s+exec\b|\blxc-attach\b/.test(bare);
}

/**
 * Commands whose output is the machine's own status, with nothing in it a stranger could have
 * written. null: any arguments; otherwise the subcommands allowed ("" for none).
 */
const STATUS: Record<string, string[] | null> = {
  uptime: null,
  free: null,
  nproc: null,
  // hostname -F reads a file and prints what it can't parse.
  hostname: [""],
  uname: null,
  whoami: null,
  id: null,
  sleep: null,
  echo: null,
  // Routes, not interfaces: an address's label, a link's alias and a FUSE mount's name (df) are
  // anyone's, as are the descriptions list-units and --failed print beside a unit.
  ip: ["r", "ro", "route"],
  systemctl: ["is-active", "is-enabled", "is-failed", "is-system-running"],
  qm: ["list", "status"],
  zfs: ["list"],
};
/**
 * Options that may come before a status command's subcommand: ones that take no value, so the word
 * after them is the subcommand. Any other option there could make its value pass for one
 * (systemctl -p is-active status nginx) or read elsewhere (ip -b FILE, docker -H HOST).
 */
const FLAGS: Record<string, string[]> = {
  ip: ["-c"],
  systemctl: ["--no-pager", "--plain", "--no-legend", "--all", "-a", "--failed", "-q", "--full"],
};
/**
 * What a status command must say, since what it prints without the flag includes a name someone else
 * picks: a unit, a container, a guest, an interface, a pool, a device or a label.
 */
const SAYS: Record<string, RegExp> = {
  // -c only colours it.
  ip: /^-c$/,
  // A failed unit's name is a unit file's: without --no-legend one named as the legend reads as it.
  systemctl: /^--no-legend$|^-q$/,
  // Deeper than a data set's own: then their names, which anyone who makes one chooses, don't show.
  zfs: /^-[^-]*d|^--depth/,
};
/** Filters a status command may pipe into, and how many operands each may have (grep's pattern). */
const FILTERS: Record<string, number> = { head: 0, tail: 0, wc: 0, sort: 0, uniq: 0, grep: 1 };

/**
 * Whether a command's output can be trusted: only status commands from the list above, piped at most
 * into filters that read no files. `writes: false`: it must also change nothing, since a status
 * command may then go where changes wait for the owner.
 */
export function statusOnly(command: string, { writes = true } = {}): boolean {
  const parsed = pipelines(command);
  if (!parsed?.lines.length) return false;
  if (!writes && parsed.files.some((f) => f !== "/dev/null")) return false;
  return parsed.lines.every((p) =>
    p.every((words, i) => {
      const w = i === 0 ? sans(words) : plain(words);
      // An empty word (-x ''): its option takes a value that says nothing.
      if (i === 0 && w.some((a) => !a)) return false;
      // df --files0-from=F, wc --files0-from=F: names read from a file come back in errors.
      if (w.some((a) => a.startsWith("-") && /^(--files|--status|--block|--force|--get)/.test(a)))
        return false;
      if (!writes && changes(w)) return false;
      return (i === 0 ? says : isFilter)(w);
    }),
  );
}

/** A command's words without leading locale settings or sudo, whose own options say nothing. */
function sans(words: string[]): string[] {
  let w = words;
  while (w[0] && /^(LANG|LANGUAGE|TZ|LC_[A-Z]+)=/.test(w[0])) w = w.slice(1);
  if (w[0] === "sudo") {
    const rest = w.slice(1);
    return rest.slice(sudoOptions(rest));
  }
  return w;
}

/** How many words sudo's options take, and with them their values. */
function sudoOptions(words: string[]): number {
  let at = 0;
  while ((words[at] ?? "").startsWith("-")) at += VALUE_OPTS.includes(words[at] ?? "") ? 2 : 1;
  return at;
}

/** A status command that says only what it may, by name rather than by what it prints. */
function says(words: string[]): boolean {
  const [prog = "", ...args] = words;
  const name = prog.split("/").pop() ?? "";
  const subs = STATUS[name];
  if (subs === undefined) return false;
  if (subs === null) return true;
  const at = args.findIndex((a) => !a.startsWith("-"));
  const before = at < 0 ? args : args.slice(0, at);
  if (!before.every((a) => FLAGS[name]?.includes(a))) return false;
  if (!subs.includes(at < 0 ? "" : (args[at] ?? ""))) return false;
  const mustSays = SAYS[name];
  return mustSays === undefined || args.some((a) => mustSays.test(a));
}

/** A status command or filter that writes all the same: sort -o FILE, ip addr flush. */
function changes(words: string[]): boolean {
  const [prog = "", ...args] = words;
  const name = prog.split("/").pop();
  // -o in any cluster (-uo F), --output, and --compress-program, which runs a program.
  if (name === "sort") return args.some((a) => /^-[^-]*o|^--(o|co)/.test(a));
  if (name !== "ip") return false;
  // After the object (addr, route…) and its flags (-4, dev eth0): nothing, or a word that only shows.
  // ip takes abbreviations (ip link s is set), so only whole words.
  const at = args.findIndex((a) => !a.startsWith("-"));
  if (at < 0) return false;
  // Options between the object and its verb come with a value of their own (dev eth0).
  for (const arg of args.slice(at + 1)) {
    if (arg.startsWith("-")) continue;
    return !["show", "list", "ls", "lst"].includes(arg);
  }
  return false;
}

function isFilter(words: string[]): boolean {
  const [prog = "", ...args] = words;
  const name = prog.split("/").pop() ?? "";
  const most = FILTERS[name];
  if (most === undefined) return false;
  if (name === "grep")
    return (
      args.every((a) => !a.startsWith("-") || /^-[icvEFwxnqo]+$/.test(a)) &&
      args.filter((a) => !a.startsWith("-")).length <= most
    );
  // A number right after an option is its value (head -n 5); any other word is a file to read,
  // or for uniq one to write (uniq -c - 5).
  const operands = args.filter(
    (a, i) => !a.startsWith("-") && !(/^[+-]?\d+$/.test(a) && /^--?[a-z]/i.test(args[i - 1] ?? "")),
  );
  return operands.length <= most;
}

/**
 * A command's words without leading locale settings (LC_ALL=C), and without sudo and its options.
 * Other variables stay, so the command doesn't pass: they can change what it runs or reads
 * (PERL5OPT for pct, LD_PRELOAD, DOCKER_HOST).
 */
function plain(words: string[]): string[] {
  let w = words;
  const locale: string[] = [];
  while (w[0] !== undefined && /^(LANG|LANGUAGE|TZ|LC_[A-Z]+)=/.test(w[0])) {
    locale.push(w[0]);
    w = w.slice(1);
  }
  // sudo's own options, which say nothing, come after the command, where they read as its words.
  if (w[0] === "sudo") {
    const opts: string[] = [];
    let rest = w.slice(1);
    while (rest.length && (rest[0] ?? "").startsWith("-")) {
      opts.push(rest[0] as string);
      rest = rest.slice(VALUE_OPTS.includes(rest[0] as string) ? 2 : 1);
    }
    w = [...rest, ...opts];
  }
  // df -h -x tmpfs: an option and its value are one word, so it isn't the subcommand.
  const out: string[] = locale;
  for (const word of w) {
    const [flag, value] = word.split(" ");
    if (flag?.startsWith("-") && value !== undefined) out.push(flag, value);
    else out.push(word);
  }
  return out;
}

const VALUE_OPTS = ["-u", "-U", "-g", "-p", "-C", "-D", "-R", "-T"];

/**
 * A shell line's plain commands as words, grouped into pipelines; null when it does more than run
 * plain commands with literal words (substitutions, variables, globs, input from files, subshells,
 * groups, here-documents). Output redirections to a plain file are left out of the words: they
 * change where output goes, not what it says. `files`: the files they write.
 */
function pipelines(line: string): { lines: string[][][]; files: string[] } | null {
  const out: string[][][] = [[[]]];
  const files: string[] = [];
  let word: string | null = null;
  const end = () => {
    if (word !== null) out.at(-1)?.at(-1)?.push(word);
    word = null;
  };
  /**
   * Skips a redirection's target: the fd it copies (2>&1), or a file. -1 for anything but a plain
   * file name: >(cmd) and >$(cmd) run a command.
   */
  const target = (i: number): number => {
    let j = i;
    if (line[j + 1] === ">") j++;
    const copy = line[j + 1] === "&";
    if (copy) j++;
    while (/[ \t]/.test(line[j + 1] ?? "")) j++;
    const from = j + 1;
    while (j + 1 < line.length && !/[\s;&|]/.test(line[j + 1] ?? "")) j++;
    const name = line.slice(from, j + 1);
    if (/[()$`<>'"\\*?[{]/.test(name)) return -1;
    // >&2 copies a stream; >&FILE writes a file like &>.
    if (!(copy && /^(\d+-?|-)$/.test(name))) files.push(name);
    return j;
  };
  for (let i = 0; i < line.length; i++) {
    const c = line[i] ?? "";
    if (c === "'") {
      const j = line.indexOf("'", i + 1);
      if (j < 0) return null;
      word = (word ?? "") + line.slice(i + 1, j);
      i = j;
    } else if (c === '"') {
      let j = i + 1;
      let w = "";
      for (; j < line.length && line[j] !== '"'; j++) {
        if (line[j] === "\\") j++;
        else if (line[j] === "`" || (line[j] === "$" && /[\w{(@*#?$!-]/.test(line[j + 1] ?? "")))
          return null;
        w += line[j] ?? "";
      }
      if (j >= line.length) return null;
      word = (word ?? "") + w;
      i = j;
    } else if (c === "\\") {
      word = (word ?? "") + (line[i + 1] ?? "");
      i++;
    } else if (c === ">") {
      // 2>/dev/null: the 2 is the fd, not a word.
      if (word !== null && /^\d+$/.test(word)) word = null;
      else end();
      i = target(i);
      if (i < 0) return null;
    } else if (c === "&" && line[i + 1] === ">") {
      end();
      i = target(i + 1);
      if (i < 0) return null;
    } else if (c === "|" && line[i + 1] !== "|") {
      end();
      out.at(-1)?.push([]);
    } else if (c === "|" || c === "&" || c === ";" || c === "\n") {
      end();
      if ((c === "|" || c === "&") && line[i + 1] === c) i++;
      out.push([[]]);
      // A glob lists files' names, and a variable prints what it holds.
    } else if ("`<(){}#$*?[".includes(c)) return null;
    else if (/\s/.test(c)) end();
    else word = (word ?? "") + c;
  }
  end();
  return { lines: out.map((p) => p.filter((cmd) => cmd.length)).filter((p) => p.length), files };
}
