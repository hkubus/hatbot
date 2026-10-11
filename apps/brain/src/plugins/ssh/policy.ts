// Which shell commands need your approval (PLAN.md §5.5: destructive patterns). A pattern list can't
// prove a command safe; it catches the obvious ways to lose data, lock yourself out, or take a
// host down, and every write still needs approval once a task has read untrusted content.
import type { ApprovalKind } from "@hatbot/shared";

const REBOOT = /\breboot\b|\binit\s+6\b/;

/** `host`: only on a host; inside a container, rebooting it is no worse than restarting a service. */
type Rule = { re: RegExp; why: string; kind?: ApprovalKind; host?: boolean };

const RULES: Rule[] = [
  { re: /\brm\s+(-\S*\s+)*-\S*[rR]/, why: "deletes files recursively", kind: "delete" },
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
    re: /\b(pct|qm)\s+(destroy|stop|shutdown|rollback|delsnapshot)\b/,
    why: "destroys or stops a guest",
    kind: "delete",
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
    re: /\bdocker\s+(compose\s+)?(rm|rmi|down|kill|prune|system\s+prune|volume\s+(rm|prune)|network\s+rm|image\s+prune|container\s+prune)\b/,
    why: "removes Docker containers, images or volumes",
    kind: "delete",
  },
  {
    re: /\b(apt|apt-get|dpkg|dnf|yum|pacman|apk)\b[^|;&]*\s(remove|purge|autoremove|erase|del|-R\w*|-r)\b/,
    why: "uninstalls packages",
    kind: "delete",
  },
  { re: /\b(userdel|groupdel|deluser|delgroup)\b/, why: "deletes accounts", kind: "delete" },
  {
    re: /\b(passwd|chpasswd|usermod|chage|visudo)\b|authorized_keys|\/etc\/(sudoers|shadow|passwd)\b|\bssh-keygen\b/,
    why: "changes accounts, passwords or keys",
    kind: "account_security",
  },
  { re: /\b(chmod|chown|chgrp)\s+(-\S*\s+)*-\S*R/, why: "changes permissions recursively" },
  {
    re: /\b(iptables|ip6tables|nft)\b[^|;&]*\s(-F|--flush|flush|-X|delete)\b|\bufw\s+(disable|reset|deny)\b/,
    why: "changes the firewall",
  },
  {
    re: /\bip\s+(link\s+set\s+\S+\s+down|addr\s+(del|flush)|route\s+(del|flush))\b|\b(ifdown|nmcli\s+\S+\s+(down|delete))\b/,
    why: "takes the network down",
  },
  { re: /\bcrontab\s+(-\S*\s+)*-r\b/, why: "deletes a crontab", kind: "delete" },
  {
    re: /\bgit\s+(push\s+[^|;&]*(-f\b|--force)|reset\s+--hard|clean\s+-\S*f|branch\s+-D)/,
    why: "rewrites or discards git history",
    kind: "delete",
  },
  {
    re: /\b(curl|wget)\b[^|;&]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/,
    why: "runs a script straight from the internet",
  },
  {
    re: /\bkill(all)?\s+(-9\s+|-KILL\s+)?(-1|1)\b|\bpkill\s+(-9\s+)?(systemd|sshd|init)\b/,
    why: "kills essential processes",
  },
  { re: /:\(\)\s*\{/, why: "looks like a fork bomb" },
  { re: /\bmv\s+[^|;&]*\s(\/dev\/null|\/)\s*$/, why: "moves files away for good", kind: "delete" },
];

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

/** Whether a command reboots the machine it runs on. */
export const reboots = (command: string) => REBOOT.test(command);
