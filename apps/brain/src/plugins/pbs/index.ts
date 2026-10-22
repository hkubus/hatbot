// The certificate is self-signed, so the connection is pinned like Proxmox VE's (src/proxmox.ts).
import { z } from "zod";
import { pinnedRequest } from "../../proxmox";
import { ask, definePlugin, needsSetup, type PluginInstance, tool } from "../plugin";
import { stamp } from "../proxmox";

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
const snapName = (s: { type: string; id: string; time: number }) =>
  `${s.type}/${s.id}/${new Date(s.time * 1000).toISOString().replace(/\.\d{3}Z$/, "Z")}`;

export const pbsPlugin = definePlugin({
  id: "pbs",
  name: "Proxmox Backup Server",
  description: "Check your backups, verify them, and clean up old ones",
  env: [
    { name: "PBS_URL", hint: "https://192.168.1.11:8007" },
    { name: "PBS_TOKEN_ID", hint: "hatbot@pbs!hatbot" },
    { name: "PBS_TOKEN_SECRET", secret: true },
    { name: "PBS_TLS_FINGERPRINT", hint: "AB:CD:EF:…" },
  ],
  config: z.object({}),
  start: async ({ env }) => {
    const url = env.PBS_URL ? new URL(env.PBS_URL) : null;
    if (!url || !env.PBS_TOKEN_ID || !env.PBS_TOKEN_SECRET || !env.PBS_TLS_FINGERPRINT)
      return needsSetup(
        "Create an API token for Hatbot in PBS (Configuration → Access Control → API Token) and give it (Permissions → Add → API Token Permission) the DatastoreAudit role on /datastore and the Audit role on /: it sees backups and tasks, not what's in them. To let it start verifies, add DatastoreReader on the datastores; for garbage collection and deleting backups, DatastoreAdmin. Both can also read every backup's contents. Then set them below.",
      );
    const pbs = {
      name: "Proxmox Backup Server",
      host: url.hostname,
      port: Number(url.port || 8007),
      fingerprint: env.PBS_TLS_FINGERPRINT,
      setting: "PBS_TLS_FINGERPRINT in Settings → PBS",
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

    /** The datastores the token may verify, and change (garbage collection, deleting), as PBS says. */
    let may: { verify: string[]; modify: string[] } | null = null;
    let unchecked: string | null = null;
    const check = async () => {
      try {
        const stores = (await get<Usage[]>("/status/datastore-usage")).map((d) => d.store).sort();
        const privs = await Promise.all(
          stores.map(async (s) => {
            const path = `/datastore/${s}`;
            const q = new URLSearchParams({ path });
            const all = await get<Record<string, Record<string, boolean>>>(
              `/access/permissions?${q}`,
            );
            return all[path] ?? {};
          }),
        );
        may = {
          verify: stores.filter((_, i) => privs[i]?.["Datastore.Verify"] !== undefined),
          modify: stores.filter((_, i) => privs[i]?.["Datastore.Modify"] !== undefined),
        };
        unchecked = null;
      } catch (err) {
        unchecked = err instanceof Error ? err.message : String(err);
      }
    };
    // Only what the token can do: a tool that always fails a 403 is worse than none.
    const offered = () =>
      tools.filter((t) => {
        const need = NEEDS[t.name];
        return !need || Boolean(may?.[need].length);
      });
    // A server that doesn't answer mustn't hold up Settings; it's checked again later.
    let wait: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      check(),
      new Promise<void>((resolve) => {
        wait = setTimeout(() => {
          if (!may) unchecked ??= "it didn't answer in 10 seconds";
          resolve();
        }, 10_000);
      }),
    ]);
    clearTimeout(wait);
    let current = offered();

    const can = () => {
      if (!may) return "Its token's privileges couldn't be checked yet, so it only looks for now.";
      const parts = [
        may.verify.length ? `verify backups in ${may.verify.join(", ")}` : null,
        may.modify.length
          ? `collect garbage and delete backups in ${may.modify.join(", ")}; deleting a backup needs approval (the safety review or the owner)`
          : null,
      ].filter(Boolean);
      return parts.length
        ? `Its token may ${parts.join(", and ")}.`
        : "Its token may only look: verifying needs the DatastoreReader role, garbage collection and deleting DatastoreAdmin.";
    };

    return {
      status: { state: "ready" },
      get tools() {
        return current;
      },
      get guidance() {
        return `Proxmox Backup Server at ${url.host}. Backup IDs of vm and ct backups are Proxmox VE guest IDs. Check pbs_backups for guests whose last backup is old, and pbs_tasks for failures. ${can()} Restoring happens in Proxmox VE, not here.`;
      },
      test: async () => {
        const list = await get<Usage[]>("/status/datastore-usage");
        await check();
        current = offered();
        return `Connected; it sees ${list.length} datastore${list.length === 1 ? "" : "s"}. ${can()}`;
      },
      down: () =>
        unchecked ? `Couldn't check what its token may do, so it only looks: ${unchecked}` : null,
      recover: async () => {
        await check();
        current = offered();
      },
      signals: async () => {
        const since = Math.floor(Date.now() / 1000) - 86400;
        const [failed, usage] = await Promise.all([
          get<PbsTask[]>(`/nodes/localhost/tasks?errors=1&limit=20&since=${since}`),
          get<Usage[]>("/status/datastore-usage"),
        ]);
        return [
          ...failed
            .filter((t) => t.endtime && t.starttime >= since)
            .map((t) => ({
              key: t.upid,
              text: `Backup server: ${t.worker_type}${t.worker_id ? ` ${t.worker_id}` : ""} at ${stamp(t.starttime)} failed: ${t.status ?? "unknown"}`,
            })),
          ...usage
            .filter((u) => u.total && u.used && u.used / u.total > 0.9)
            .map((u) => ({
              key: `full:${u.store}`,
              text: `Backup server: datastore ${u.store} is ${Math.round(((u.used ?? 0) / (u.total ?? 1)) * 100)}% full (${gib(u.avail)} left)`,
            })),
        ];
      },
    } satisfies PluginInstance;
  },
});

const NEEDS: Record<string, "verify" | "modify"> = {
  pbs_verify: "verify",
  pbs_garbage_collect: "modify",
  pbs_delete_snapshot: "modify",
};
