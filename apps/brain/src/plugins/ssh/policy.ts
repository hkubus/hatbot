// Which shell commands need your approval (PLAN.md §5.5: destructive patterns). A pattern list can't
// prove a command safe; it catches the obvious ways to lose data, lock yourself out, or take a
// host down, and every write still needs approval once a task has read untrusted content.
import type { ApprovalKind } from "@hatbot/shared";

const REBOOT = /\breboot\b|\binit\s+6\b/;

/** `host`: only on a host; inside a container, rebooting it is no worse than restarting a service. */
type Rule = { re: RegExp; why: string; kind?: ApprovalKind; host?: boolean };

const RULES: Rule[] = [
  // Flags can come after the paths too: rm /srv/old -rf.
  {
    re: /\brm\b[^|;&\n]*\s(-(?!-)[a-zA-Z]*[rR]|--recursive\b)/,
    why: "deletes files recursively",
    kind: "delete",
  },
  { re: /\brm\s+(-\S*\s+)*\S*(\/\*|\s\/\s*$|\s~\/?\s*$)/, why: "deletes files", kind: "delete" },
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
    re: /\bfind\b[^|;&\n]*\s(-delete\b|-exec(dir)?\s+(sudo\s+)?(rm|shred|unlink)\b)/,
    why: "deletes the files it finds",
    kind: "delete",
  },
  { re: /\bxargs\b[^|;&\n]*\b(rm|shred|unlink|rmdir)\b/, why: "deletes files", kind: "delete" },
  {
    re: /\brsync\b[^|;&\n]*\s--(delete|remove-source-files)/,
    why: "deletes files with rsync",
    kind: "delete",
  },
  {
    re: /\b(pct|qm)\s+(destroy|stop|shutdown|rollback|delsnapshot)\b/,
    why: "destroys or stops a guest",
    kind: "delete",
  },
  { re: /\bpvesh\s+delete\b/, why: "deletes something in Proxmox", kind: "delete" },
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
  { re: /\bsystemctl\s+(\S+\s+)*(stop|disable|mask|kill)\b/, why: "stops or disables a service" },
  {
    re: /\b(docker(-compose)?|podman)\s+(compose\s+)?(rm|rmi|down|kill|prune|system\s+prune|volume\s+(rm|prune)|network\s+rm|image\s+prune|container\s+(prune|rm|kill))\b/,
    why: "removes Docker containers, images or volumes",
    kind: "delete",
  },
  {
    re: /\b(docker(-compose)?|podman)\s+(compose\s+|container\s+)?(stop|pause)\b/,
    why: "stops Docker containers",
  },
  {
    re: /\b(apt|apt-get|dpkg|dnf|yum|pacman|apk)\b[^|;&]*\s(remove|purge|autoremove|erase|del|-R\w*|-r)\b/,
    why: "uninstalls packages",
    kind: "delete",
  },
  { re: /\b(userdel|groupdel|deluser|delgroup)\b/, why: "deletes accounts", kind: "delete" },
  {
    re: /\b(passwd|chpasswd|usermod|chage|visudo|useradd|adduser|groupadd|addgroup|gpasswd)\b|authorized_keys|\/etc\/(sudoers|shadow|passwd)\b|\bssh-keygen\b|\bpveum\b[^|;&\n]*\s(add|modify|delete|remove|passwd)\b/,
    why: "changes accounts, passwords or keys",
    kind: "account_security",
  },
  { re: /\b(chmod|chown|chgrp)\s+(-\S*\s+)*-\S*R/, why: "changes permissions recursively" },
  {
    re: /\b(iptables|ip6tables)(-legacy|-nft)?\b[^|;&\n]*\s(-[AIDRPFX]\b|--(append|insert|delete|replace|policy|flush|delete-chain)\b)|\b(iptables|ip6tables)(-legacy|-nft)?-restore\b|\bnft\b[^|;&\n]*\s(add|insert|delete|flush|replace|destroy|-f)\b|\bufw\s+(--?\S+\s+)*(allow|deny|reject|limit|delete|insert|prepend|disable|enable|reset|default|route|reload)\b/,
    why: "changes the firewall",
  },
  {
    re: /\bip\s+(link\s+set\s+\S+\s+down|addr\s+(del|flush)|route\s+(del|flush))\b|\b(ifdown|nmcli\s+\S+\s+(down|delete))\b/,
    why: "takes the network down",
  },
  { re: /\bcrontab\s+(-\S*\s+)*-r\b/, why: "deletes a crontab", kind: "delete" },
  {
    // + and : refspecs force-push and delete: git push origin +main, git push origin :main.
    re: /\bgit\s+(push\b[^|;&\n]*\s(-f\b|--force|--mirror|--delete|-d\b|\+\S|:\S)|reset\s+--hard|clean\s+-\S*f|branch\s+-D)/,
    why: "rewrites or discards git history",
    kind: "delete",
  },
  {
    re: /\b(curl|wget)\b[^|;&]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/,
    why: "runs a script straight from the internet",
  },
  // bash <(curl …), sh -c "$(curl …)", source <(wget …)
  {
    re: /[<$]\(\s*(sudo\s+)?(curl|wget)\b/,
    why: "runs a script straight from the internet",
  },
  {
    re: /\bkill(all)?\s+(-9\s+|-KILL\s+)?(-1|1)\b|\bpkill\s+(-9\s+)?(systemd|sshd|init)\b/,
    why: "kills essential processes",
  },
  { re: /\b(killall|pkill)\b/, why: "kills processes by name" },
  { re: /:\(\)\s*\{/, why: "looks like a fork bomb" },
  { re: /\bmv\s+[^|;&]*\s(\/dev\/null|\/)\s*$/, why: "moves files away for good", kind: "delete" },
];

/**
 * Roughly how many commands a shell line runs: one per part between ;, && and ||, and a loop or
 * xargs runs any number. Pipes are one command.
 */
export function commandCount(command: string): number {
  if (
    /\b(for|while|until)\b[\s\S]*\bdo\b|\b(xargs|parallel)\b|\bfind\b[^|;&]*\s-exec/.test(command)
  )
    return Number.POSITIVE_INFINITY;
  return Math.max(1, command.split(/;|&&|\|\||\n/).filter((part) => part.trim()).length);
}

/** Why this command needs approval, or null. `where`: on a host, or inside a container (ssh_pct_exec). */
export function destructive(
  command: string,
  where: "host" | "container" = "host",
): { why: string; kind: ApprovalKind } | null {
  for (const r of RULES)
    if (!(r.host && where === "container") && r.re.test(command))
      return { why: r.why.replace("{where}", `the ${where}`), kind: r.kind ?? "other" };
  return null;
}

/**
 * Commands whose output is the machine's own status, with nothing in it a stranger could have
 * written (PLAN.md §6.1). null: any arguments; otherwise the subcommands allowed ("" for none).
 */
const STATUS: Record<string, string[] | null> = {
  uptime: null,
  df: null,
  free: null,
  nproc: null,
  hostname: null,
  uname: null,
  whoami: null,
  id: null,
  date: null,
  lsblk: null,
  echo: null,
  true: null,
  sleep: null,
  ip: ["a", "addr", "address", "r", "ro", "route", "l", "link", "n", "neigh"],
  systemctl: ["", "is-active", "is-enabled", "is-failed", "is-system-running", "list-units"],
  pct: ["list", "status"],
  qm: ["list", "status"],
  docker: ["ps"],
  zpool: ["list", "status"],
  zfs: ["list"],
};
/** Filters a status command may pipe into, and how many operands each may have (grep's pattern). */
const FILTERS: Record<string, number> = { head: 0, tail: 0, wc: 0, sort: 0, uniq: 0, grep: 1 };

/**
 * Whether a command's output can be trusted: every part is a status command from the short list
 * above, piped at most into filters that read no files. Anything else (logs, files, a command
 * substitution, input from a file) may carry what strangers wrote, so its output is untrusted.
 */
export function statusOnly(command: string): boolean {
  const lines = pipelines(command);
  return Boolean(
    lines?.length &&
      lines.every((p) => p.every((words, i) => (i === 0 ? isStatus : isFilter)(plain(words)))),
  );
}

function isStatus(words: string[]): boolean {
  const [prog = "", ...args] = words;
  const subs = STATUS[prog.split("/").pop() ?? ""];
  if (subs === undefined) return false;
  return subs === null || subs.includes(args.find((a) => !a.startsWith("-")) ?? "");
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
  // A number right after an option is its value (head -n 5); any other word is a file to read.
  const operands = args.filter(
    (a, i) => !a.startsWith("-") && !(/^[+-]?\d+$/.test(a) && args[i - 1]?.startsWith("-")),
  );
  return operands.length <= most;
}

/** A command's words without leading VAR=value assignments, and without sudo and its options. */
function plain(words: string[]): string[] {
  let w = words;
  while (w[0] && /^[A-Za-z_]\w*=/.test(w[0])) w = w.slice(1);
  if (w[0] === "sudo") {
    w = w.slice(1);
    while (w[0]?.startsWith("-")) w = w.slice(w[0] === "-u" || w[0] === "-g" ? 2 : 1);
  }
  return w;
}

/**
 * A shell line's plain commands as words, grouped into pipelines; null when it does more than run
 * plain commands (substitutions, input from files, subshells, groups, here-documents). Output
 * redirections are dropped: they change where output goes, not what it says.
 */
function pipelines(line: string): string[][][] | null {
  const out: string[][][] = [[[]]];
  let word: string | null = null;
  const end = () => {
    if (word !== null) out.at(-1)?.at(-1)?.push(word);
    word = null;
  };
  /** Skips a redirection's target: the fd it copies (2>&1), or a file. */
  const target = (i: number): number => {
    let j = i;
    if (line[j + 1] === ">") j++;
    if (line[j + 1] === "&") {
      j++;
      while (/[\d-]/.test(line[j + 1] ?? "")) j++;
      return j;
    }
    while (/[ \t]/.test(line[j + 1] ?? "")) j++;
    while (j + 1 < line.length && !/[\s;&|]/.test(line[j + 1] ?? "")) j++;
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
        else if (line[j] === "`" || (line[j] === "$" && line[j + 1] === "(")) return null;
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
    } else if (c === "&" && line[i + 1] === ">") {
      end();
      i = target(i + 1);
    } else if (c === "|" && line[i + 1] !== "|") {
      end();
      out.at(-1)?.push([]);
    } else if (c === "|" || c === "&" || c === ";" || c === "\n") {
      end();
      if ((c === "|" || c === "&") && line[i + 1] === c) i++;
      out.push([[]]);
    } else if ("`<(){}#".includes(c)) return null;
    else if (/\s/.test(c)) end();
    else word = (word ?? "") + c;
  }
  end();
  return out.map((p) => p.filter((cmd) => cmd.length)).filter((p) => p.length);
}
