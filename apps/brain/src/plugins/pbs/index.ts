// Proxmox Backup Server: datastores, backups and their verification, and recent tasks. It can start a
// verify or a garbage collection; deleting a backup asks you. Restores happen in Proxmox VE, not here.
// The certificate is self-signed, so the connection is pinned like Proxmox VE's (src/proxmox.ts).
import { z } from "zod";
import { pinnedRequest } from "../../proxmox";
import { allow, ask, definePlugin, needsSetup, ready, tool } from "../plugin";

type Usage = {
  store: string;
  total?: number;
  used?: number;
  avail?: number;
  "estimated-full-date"?: number;
  error?: string;
};
type Group = {
  "backup-type": string;
  "backup-id": string;
  "last-backup": number;
  "backup-count": number;
  comment?: string;
};
type Snap = {
  "backup-type": string;
  "backup-id": string;
  "backup-time": number;
  size?: number;
  protected?: boolean;
  comment?: string;
  verification?: { state: string } | null;
};
type PbsTask = {
  upid: string;
  worker_type: string;
  worker_id?: string | null;
  starttime: number;
  endtime?: number;
  status?: string;
};

const Store = z
  .string()
  .regex(/^[\w.-]+$/, "a datastore name")
  .describe("The datastore, as pbs_datastores lists it");
const Type = z.enum(["vm", "ct", "host"]).describe("vm, ct or host");
const Id = z
  .string()
  .regex(/^[\w.-]+$/, "a backup ID")
  .describe('The backup ID: the guest\'s VMID for vm and ct, e.g. "105"');
const Time = z
  .number()
  .int()
  .positive()
  .describe("The snapshot's backup-time, in Unix seconds, as pbs_snapshots lists it");

const gib = (b = 0) => `${(b / 1024 ** 3).toFixed(1)} GiB`;
const stamp = (s: number) => new Date(s * 1000).toISOString().slice(0, 16).replace("T", " ");
const snapName = (s: { type: string; id: string; time: number }) =>
  `${s.type}/${s.id}/${new Date(s.time * 1000).toISOString().replace(/\.\d{3}Z$/, "Z")}`;

export const pbsPlugin = definePlugin({
  id: "pbs",
  name: "Proxmox Backup Server",
  description: "Check your backups, verify them, and clean up old ones",
  secrets: ["PBS_URL", "PBS_TOKEN_ID", "PBS_TOKEN_SECRET", "PBS_TLS_FINGERPRINT"],
  config: z.object({}),
  start: ({ env }) => {
    const url = env.PBS_URL ? new URL(env.PBS_URL) : null;
    if (!url || !env.PBS_TOKEN_ID || !env.PBS_TOKEN_SECRET || !env.PBS_TLS_FINGERPRINT)
      return needsSetup(
        "Create an API token for Hatbot in PBS (Configuration → Access Control → API Token, with DatastoreAudit and DatastoreBackup on /datastore, and Sys.Audit on /), then put PBS_URL, PBS_TOKEN_ID, PBS_TOKEN_SECRET and PBS_TLS_FINGERPRINT (from the PBS dashboard's Show Fingerprint) in /etc/hatbot/pbs.env on the brain and restart it.",
      );
    const pbs = {
      name: "Proxmox Backup Server",
      host: url.hostname,
      port: Number(url.port || 8007),
      fingerprint: env.PBS_TLS_FINGERPRINT,
      auth: `PBSAPIToken=${env.PBS_TOKEN_ID}:${env.PBS_TOKEN_SECRET}`,
    };
    const get = <T>(path: string) => pinnedRequest(pbs, "GET", path) as Promise<T>;
    const store = (s: string) => `/admin/datastore/${encodeURIComponent(s)}`;
    const snapQuery = (type: string, id: string, time?: number) =>
      new URLSearchParams({
        "backup-type": type,
        "backup-id": id,
        ...(time ? { "backup-time": String(time) } : {}),
      }).toString();

    const tools = [
      tool({
        name: "pbs_datastores",
        description:
          "Every datastore on the backup server: used and free space, and when it's estimated to fill up.",
        access: "read",
        label: "Checking backup storage",
        schema: z.object({}),
        run: async () => {
          const list = await get<Usage[]>("/status/datastore-usage");
          return (
            list
              .map((d) => {
                if (d.error) return `${d.store}: ${d.error}`;
                const pct = d.total ? Math.round(((d.used ?? 0) / d.total) * 100) : 0;
                const full = d["estimated-full-date"];
                return `${d.store}: ${gib(d.used)} of ${gib(d.total)} used (${pct}%), ${gib(d.avail)} free${full && full > 0 ? `, full around ${stamp(full).slice(0, 10)}` : ""}`;
              })
              .join("\n") || "No datastores."
          );
        },
      }),
      tool({
        name: "pbs_backups",
        description:
          "The backup groups in a datastore, one per guest or host: how many snapshots and when the last one ran. Oldest last backup first, so missed backups show at the top.",
        access: "read",
        label: "Checking backups",
        schema: z.object({ store: Store }),
        describe: ({ store }) => `Backups in ${store}`,
        run: async ({ store: s }) => {
          const groups = await get<Group[]>(`${store(s)}/groups`);
          return (
            groups
              .sort((a, b) => a["last-backup"] - b["last-backup"])
              .map(
                (g) =>
                  `${g["backup-type"]}/${g["backup-id"]}${g.comment ? ` (${g.comment})` : ""}: ${g["backup-count"]} snapshots, last ${stamp(g["last-backup"])}`,
              )
              .join("\n") || "No backups in this datastore."
          );
        },
      }),
      tool({
        name: "pbs_snapshots",
        description:
          "One guest's or host's snapshots in a datastore, newest first: time, size, verify state and whether it's protected.",
        access: "read",
        label: "Listing snapshots",
        schema: z.object({ store: Store, type: Type, id: Id }),
        describe: ({ store, type, id }) => `Snapshots of ${type}/${id} in ${store}`,
        run: async ({ store: s, type, id }) => {
          const snaps = await get<Snap[]>(`${store(s)}/snapshots?${snapQuery(type, id)}`);
          return (
            snaps
              .sort((a, b) => b["backup-time"] - a["backup-time"])
              .map(
                (n) =>
                  `${stamp(n["backup-time"])} (backup-time ${n["backup-time"]}): ${gib(n.size)}, ${n.verification?.state ? `verify ${n.verification.state}` : "not verified"}${n.protected ? ", protected" : ""}${n.comment ? `, ${n.comment}` : ""}`,
              )
              .join("\n") || `No snapshots of ${type}/${id}.`
          );
        },
      }),
      tool({
        name: "pbs_tasks",
        description:
          "Recent tasks on the backup server (backups, verifies, prunes, garbage collection, syncs), newest first. errors_only for just the failures.",
        access: "read",
        label: "Checking backup tasks",
        schema: z.object({
          errors_only: z.boolean().default(false).describe("Only tasks that failed"),
          limit: z.number().int().min(1).max(100).default(30),
        }),
        run: async ({ errors_only, limit }) => {
          const q = new URLSearchParams({
            limit: String(limit),
            ...(errors_only ? { errors: "1" } : {}),
          });
          const list = await get<PbsTask[]>(`/nodes/localhost/tasks?${q}`);
          return (
            list
              .map(
                (t) =>
                  `${stamp(t.starttime)} ${t.worker_type}${t.worker_id ? ` ${t.worker_id}` : ""}: ${t.endtime ? (t.status ?? "unknown") : "running"}`,
              )
              .join("\n") || (errors_only ? "No failed tasks." : "No tasks.")
          );
        },
      }),
      tool({
        name: "pbs_verify",
        description:
          "Start verifying backups in a datastore: all of it, one guest's snapshots, or one snapshot. It runs on the server; pbs_tasks shows how it went.",
        access: "write",
        label: "Starting a verify",
        schema: z.object({
          store: Store,
          type: Type.optional(),
          id: Id.optional(),
          time: Time.optional(),
        }),
        describe: ({ store, type, id, time }) =>
          type && id
            ? `Verify ${time ? snapName({ type, id, time }) : `${type}/${id}`} in ${store}`
            : `Verify datastore ${store}`,
        policy: () => allow(),
        run: async ({ store: s, type, id, time }) => {
          const form: Record<string, string> = {};
          if (type && id) {
            form["backup-type"] = type;
            form["backup-id"] = id;
            if (time) form["backup-time"] = String(time);
          }
          const upid = await pinnedRequest(pbs, "POST", `${store(s)}/verify`, form);
          return `Started verifying (task ${String(upid)}).`;
        },
      }),
      tool({
        name: "pbs_garbage_collect",
        description:
          "Start garbage collection on a datastore, which frees the space of chunks no snapshot uses any more. It only removes what's already unreferenced.",
        access: "write",
        label: "Starting garbage collection",
        schema: z.object({ store: Store }),
        describe: ({ store }) => `Garbage collect ${store}`,
        policy: () => allow(),
        run: async ({ store: s }) => {
          const upid = await pinnedRequest(pbs, "POST", `${store(s)}/gc`);
          return `Started garbage collection (task ${String(upid)}).`;
        },
      }),
      tool({
        name: "pbs_delete_snapshot",
        description: "Delete one backup snapshot. It can't be undone.",
        access: "write",
        label: "Deleting a backup",
        schema: z.object({ store: Store, type: Type, id: Id, time: Time }),
        describe: ({ store, type, id, time }) =>
          `Delete backup ${snapName({ type, id, time })} from ${store}`,
        policy: () => ask("Deleting a backup can't be undone.", "delete"),
        run: async ({ store: s, type, id, time }) => {
          await pinnedRequest(pbs, "DELETE", `${store(s)}/snapshots?${snapQuery(type, id, time)}`);
          return `Deleted ${snapName({ type, id, time })}.`;
        },
      }),
    ];

    return ready(tools, {
      guidance: `Proxmox Backup Server at ${url.host}. Backup IDs of vm and ct backups are Proxmox VE guest IDs. Check pbs_backups for guests whose last backup is old, and pbs_tasks for failures. Starting a verify or garbage collection runs without asking; deleting a backup asks the owner. Restoring happens in Proxmox VE, not here.`,
      test: async () => {
        const list = await get<Usage[]>("/status/datastore-usage");
        return `Connected; it sees ${list.length} datastore${list.length === 1 ? "" : "s"}.`;
      },
    });
  },
});
