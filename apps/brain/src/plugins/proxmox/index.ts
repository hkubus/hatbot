// Proxmox (PLAN.md §5.5, §9.3): see every guest, start and reboot them, and ask before shutting one
// down. Uses the scoped token from /etc/hatbot/proxmox.env, which can't change configs or destroy.
import { z } from "zod";
import { Proxmox, ProxmoxError } from "../../proxmox";
import { allow, ask, askAlways, block, definePlugin, needsSetup, ready, tool } from "../plugin";

/** How long a power action may take before the tool stops waiting. */
const POWER_TIMEOUT_MS = 3 * 60_000;

type Resource = {
  id: string;
  vmid: number;
  name?: string;
  type: "lxc" | "qemu";
  node: string;
  status: string;
  cpu?: number;
  maxcpu?: number;
  mem?: number;
  maxmem?: number;
  disk?: number;
  maxdisk?: number;
  uptime?: number;
  tags?: string;
  pool?: string;
  template?: number;
};

const Config = z.object({
  /**
   * Guests where every change waits for the owner, e.g. the router or the NAS: power actions here,
   * and commands and files in them through the SSH plugin.
   */
  careful: z.array(z.number().int().positive()).default([]),
});

const Vmid = z.number().int().positive().describe("The guest's ID, e.g. 105");

export const proxmoxPlugin = definePlugin({
  id: "proxmox",
  name: "Proxmox",
  description: "See your guests, start and reboot them",
  secrets: [
    "PROXMOX_URL",
    "PROXMOX_NODE",
    "PROXMOX_TOKEN_ID",
    "PROXMOX_TOKEN_SECRET",
    "PROXMOX_TLS_FINGERPRINT",
  ],
  config: Config,
  start: ({ env, config }) => {
    const pve = new Proxmox(env);
    if (!pve.hasApi)
      return needsSetup(
        "The brain has no Proxmox token. Run infra/host-setup.sh on the host; it writes /etc/hatbot/proxmox.env.",
      );
    const brain = Number(pve.brainId) || null;
    const desktop = Number(pve.desktopId) || null;
    /** Names from the last listing, so timeline lines and approvals can say which guest. */
    const names = new Map<number, string>();
    /** Guests tagged as Hatbot's own (host-setup.sh tags them), from the last listing. */
    const own = new Set<number>();

    const guests = async (): Promise<Resource[]> => {
      const list = ((await pve.get("/cluster/resources?type=vm")) as Resource[])
        .filter((r) => !r.template)
        .sort((a, b) => a.vmid - b.vmid);
      own.clear();
      for (const r of list) {
        names.set(r.vmid, label(r));
        if (ownTag(r)) own.add(r.vmid);
      }
      return list;
    };
    /** Hatbot's own guests other than the desktop are never powered, whatever their ID now. */
    const refused = (vmid: number) => vmid === brain || (own.has(vmid) && vmid !== desktop);
    const find = async (vmid: number): Promise<Resource> => {
      const r = (await guests()).find((g) => g.vmid === vmid);
      if (!r) throw new ProxmoxError(`There's no guest ${vmid}.`);
      return r;
    };
    const path = (r: Resource) => `/nodes/${encodeURIComponent(r.node)}/${r.type}/${r.vmid}`;
    const named = (vmid: number) => names.get(vmid) ?? `guest ${vmid}`;
    void guests().catch(() => {});

    const careful = new Set(config.careful);
    const tools = [
      tool({
        name: "proxmox_guests",
        description:
          "Every VM and container on the Proxmox host: ID, name, type, status, uptime, CPU, memory, disk and tags.",
        access: "read",
        label: "Checking guests",
        schema: z.object({}),
        run: async () => (await guests()).map(guestLine).join("\n") || "No guests.",
      }),
      tool({
        name: "proxmox_guest",
        description:
          "One guest in detail: its live status (CPU, memory, disk, network, lock) and its configuration (cores, memory, disks, network, start at boot).",
        access: "read",
        label: "Checking a guest",
        schema: z.object({ vmid: Vmid }),
        describe: ({ vmid }) => `Looked at ${named(vmid)}`,
        run: async ({ vmid }) => {
          const r = await find(vmid);
          const [status, cfg] = (await Promise.all([
            pve.get(`${path(r)}/status/current`),
            pve.get(`${path(r)}/config`),
          ])) as [Record<string, unknown>, Record<string, unknown>];
          const live = [
            `${label(r)}: ${status.status}${status.lock ? `, locked (${status.lock})` : ""}`,
            status.uptime ? `Up ${duration(Number(status.uptime))}` : null,
            `CPU ${pct(status.cpu)} of ${status.cpus ?? r.maxcpu} cores`,
            `Memory ${bytes(status.mem)} of ${bytes(status.maxmem)}`,
            status.maxswap ? `Swap ${bytes(status.swap)} of ${bytes(status.maxswap)}` : null,
            status.maxdisk ? `Disk ${bytes(status.disk)} of ${bytes(status.maxdisk)}` : null,
            `Network in ${bytes(status.netin)}, out ${bytes(status.netout)} since start`,
          ].filter(Boolean);
          const config = Object.entries(cfg)
            .filter(([k]) => k !== "digest")
            .map(([k, v]) => `${k}: ${String(v).slice(0, 300)}`);
          return `${live.join("\n")}\n\nConfiguration\n${config.join("\n")}`;
        },
      }),
      tool({
        name: "proxmox_node",
        description:
          "The Proxmox host itself: CPU, memory, load, uptime, Proxmox version, and how full each storage is.",
        access: "read",
        label: "Checking the host",
        schema: z.object({}),
        run: async () => {
          const node = encodeURIComponent(pve.node);
          const [st, storage] = (await Promise.all([
            pve.get(`/nodes/${node}/status`),
            pve.get(`/nodes/${node}/storage`),
          ])) as [NodeStatus, StorageRow[]];
          const lines = [
            `Node ${pve.node}: ${st.pveversion ?? "Proxmox VE"}, up ${duration(st.uptime ?? 0)}`,
            `CPU ${pct(st.cpu)}, load ${st.loadavg?.join(" ") ?? "?"}`,
            `Memory ${bytes(st.memory?.used)} of ${bytes(st.memory?.total)}`,
            st.swap?.total ? `Swap ${bytes(st.swap.used)} of ${bytes(st.swap.total)}` : null,
            `Root disk ${bytes(st.rootfs?.used)} of ${bytes(st.rootfs?.total)}`,
            "",
            "Storage",
            ...storage
              .sort((a, b) => a.storage.localeCompare(b.storage))
              .map(
                (s) =>
                  `${s.storage} (${s.type})${s.active ? "" : ", inactive"}: ${bytes(s.used)} of ${bytes(s.total)}${s.total ? ` (${Math.round(((s.used ?? 0) / s.total) * 100)}%)` : ""}`,
              ),
          ];
          return lines.filter((l) => l !== null).join("\n");
        },
      }),
      tool({
        name: "proxmox_tasks",
        description:
          "Recent Proxmox tasks (backups, starts, stops, snapshots) with how they ended, newest first. Give vmid for one guest's tasks.",
        access: "read",
        label: "Checking Proxmox tasks",
        schema: z.object({
          vmid: Vmid.optional(),
          failed_only: z.boolean().optional().describe("Only tasks that didn't end OK"),
        }),
        run: async ({ vmid, failed_only }) => {
          const list = ((await pve.get("/cluster/tasks")) as TaskRow[])
            .filter((t) => vmid === undefined || t.id === String(vmid))
            .filter((t) => !failed_only || (t.status && t.status !== "OK"))
            .sort((a, b) => b.starttime - a.starttime)
            .slice(0, 25);
          return (
            list
              .map(
                (t) =>
                  `${stamp(t.starttime)} ${t.type}${t.id ? ` ${t.id}` : ""} by ${t.user}: ${t.endtime ? (t.status ?? "?") : "running"}`,
              )
              .join("\n") || "No tasks."
          );
        },
      }),
      // Only while the brain knows its own ID: the token may power every guest, the brain included.
      ...(brain
        ? [
            tool({
              name: "proxmox_power",
              description:
                "Start, reboot, shut down (clean) or stop (hard power-off) a guest, and wait until Proxmox is done. Starting and rebooting run right away; shutting down or stopping asks the owner first.",
              access: "write",
              schema: z.object({
                vmid: Vmid,
                action: z.enum(["start", "reboot", "shutdown", "stop"]),
              }),
              describe: ({ vmid, action }) => `${ACTION[action]} ${named(vmid)}`,
              policy: ({ vmid, action }) => {
                if (refused(vmid))
                  return block(
                    vmid === brain
                      ? "That's Hatbot's own brain: powering it would end this task. Ask the owner to do it."
                      : "That's one of Hatbot's own guests (tagged hatbot). Ask the owner to do it.",
                  );
                const off =
                  action === "shutdown" || action === "stop"
                    ? "It stays off until someone starts it again."
                    : null;
                if (careful.has(vmid))
                  return askAlways(
                    `The owner asked to approve power actions on it.${off ? ` ${off}` : ""}`,
                  );
                if (off) return ask(off);
                if (vmid === desktop) return ask("The desktop may be in use by a desktop task.");
                return allow();
              },
              run: async ({ vmid, action }, { signal }) => {
                const r = await find(vmid);
                // Checked again on the fresh listing: the policy saw the last one.
                if (refused(vmid))
                  throw new ProxmoxError(
                    `${label(r)} is one of Hatbot's own guests (tagged hatbot); it isn't powered from here.`,
                  );
                const upid = (await pve.post(`${path(r)}/status/${action}`)) as string;
                const exit = await pve.waitTask(upid, POWER_TIMEOUT_MS, signal);
                const now = (await pve.get(`${path(r)}/status/current`)) as { status?: string };
                if (exit === null)
                  return `${ACTION[action]} ${label(r)} is still going after 3 minutes; it's ${now.status} now.`;
                if (exit !== "OK")
                  throw new ProxmoxError(
                    `${ACTION[action]} ${label(r)} failed: ${exit}. It's ${now.status}.`,
                  );
                return `${ACTION[action]} ${label(r)}: done. It's ${now.status} now.`;
              },
            }),
          ]
        : []),
      tool({
        name: "proxmox_snapshot",
        description:
          "Take a snapshot of one of Hatbot's own guests (the brain or the desktop), e.g. before a risky change. Other guests are refused by Proxmox.",
        access: "write",
        schema: z.object({
          vmid: Vmid,
          name: z
            .string()
            .regex(/^[A-Za-z][\w-]{1,39}$/)
            .describe("Letters, digits, - and _; starts with a letter"),
          description: z.string().max(200).optional(),
        }),
        describe: ({ vmid, name }) => `Snapshot ${named(vmid)} as ${name}`,
        run: async ({ vmid, name, description }, { signal }) => {
          const r = await find(vmid);
          const upid = (await pve.post(`${path(r)}/snapshot`, {
            snapname: name,
            description: description ?? "Taken by Hatbot",
          })) as string;
          const exit = await pve.waitTask(upid, POWER_TIMEOUT_MS, signal);
          if (exit !== "OK")
            throw new ProxmoxError(`The snapshot of ${label(r)} failed: ${exit ?? "timed out"}.`);
          return `Took snapshot ${name} of ${label(r)}.`;
        },
      }),
    ];

    const special = [
      brain
        ? `Guest ${brain} is Hatbot's own brain; never power it.`
        : "Powering guests is off until HATBOT_BRAIN_ID is set in /etc/hatbot/proxmox.env, so the brain can't be powered off by mistake.",
      desktop ? `Guest ${desktop} is your desktop.` : null,
      careful.size
        ? `Power actions on ${[...careful].join(", ")}, and commands and files in them, always wait for the owner.`
        : null,
    ].filter(Boolean);
    return ready(tools, {
      guidance:
        `Proxmox host "${pve.node}". proxmox_guests lists every guest; read memory for what each one runs. Starting and rebooting a guest runs right away; shutting one down or stopping it asks the owner first. ${special.join(" ")}`.trim(),
      test: async () => {
        const list = await guests();
        const running = list.filter((g) => g.status === "running").length;
        return `Connected to ${pve.node}: ${list.length} guests, ${running} running.${brain ? "" : " Powering guests is off until HATBOT_BRAIN_ID is set in /etc/hatbot/proxmox.env."}`;
      },
    });
  },
});

type NodeStatus = {
  cpu?: number;
  loadavg?: string[];
  memory?: { used: number; total: number };
  swap?: { used: number; total: number };
  rootfs?: { used: number; total: number };
  uptime?: number;
  pveversion?: string;
};
type StorageRow = {
  storage: string;
  type: string;
  active?: number;
  used?: number;
  total?: number;
};
type TaskRow = {
  type: string;
  id?: string;
  user: string;
  status?: string;
  starttime: number;
  endtime?: number;
};

const ACTION = { start: "Start", reboot: "Reboot", shutdown: "Shut down", stop: "Stop" };

/** Tagged as one of Hatbot's own guests: Proxmox keeps tags as "a;b". */
const ownTag = (r: Resource) => (r.tags ?? "").split(/[;, ]+/).includes("hatbot");

const label = (r: Resource) =>
  `${r.type === "lxc" ? "CT" : "VM"} ${r.vmid}${r.name ? ` (${r.name})` : ""}`;

function guestLine(r: Resource): string {
  const parts = [`${label(r)}: ${r.status}`];
  if (r.status === "running") {
    if (r.uptime) parts.push(`up ${duration(r.uptime)}`);
    parts.push(`CPU ${pct(r.cpu)} of ${r.maxcpu}`);
    parts.push(`memory ${bytes(r.mem)} of ${bytes(r.maxmem)}`);
  }
  if (r.maxdisk) parts.push(`disk ${bytes(r.disk)} of ${bytes(r.maxdisk)}`);
  if (r.tags) parts.push(`tags ${r.tags.replaceAll(";", ", ")}`);
  if (r.pool) parts.push(`pool ${r.pool}`);
  return parts.join(", ");
}

export function bytes(n: unknown): string {
  const v = Number(n ?? 0);
  if (!v) return "0";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(v) / Math.log(1024)));
  const x = v / 1024 ** i;
  return `${x >= 10 || i === 0 ? Math.round(x) : x.toFixed(1)} ${units[i]}`;
}

const pct = (n: unknown) => `${Math.round(Number(n ?? 0) * 100)}%`;

export function duration(s: number): string {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

const stamp = (unix: number) => new Date(unix * 1000).toISOString().slice(0, 16).replace("T", " ");
