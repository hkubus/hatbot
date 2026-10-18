import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { pbsPlugin } from "../src/plugins/pbs";
import type { CallContext } from "../src/plugins/plugin";
import { verdictFor } from "../src/plugins/registry";
import { FakeModel } from "./fake-model";
import { testApp, waitFor } from "./helpers";

const FINGERPRINT =
  "D7:6A:C1:55:98:6E:33:E6:73:98:B6:92:28:50:A5:F7:F0:69:D9:96:AD:CC:64:25:0D:DA:0F:BC:7A:4C:40:D0";
const fixtures = join(import.meta.dir, "fixtures");
const seen: { method: string; path: string; auth: string | null; body: string }[] = [];
let server: ReturnType<typeof Bun.serve>;
/** What the token may do on the datastore "main"; null answers 403, as an old token's check would. */
let privs: Record<string, boolean> | null = {
  "Datastore.Audit": true,
  "Datastore.Verify": true,
  "Datastore.Modify": true,
};

// A stand-in for the backup server's proxy, with a self-signed certificate.
beforeAll(() => {
  server = Bun.serve({
    port: 0,
    tls: {
      cert: Bun.file(join(fixtures, "pve-cert.pem")),
      key: Bun.file(join(fixtures, "pve-key.pem")),
    },
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname.replace("/api2/json", "");
      seen.push({
        method: req.method,
        path: path + url.search,
        auth: req.headers.get("authorization"),
        body: await req.text(),
      });
      const data = (d: unknown) => Response.json({ data: d });
      if (path === "/access/permissions" && url.searchParams.get("path") === "/datastore/main")
        return privs
          ? data({ "/datastore/main": privs })
          : new Response(null, { status: 500, statusText: "Internal Server Error" });
      if (path === "/status/datastore-usage")
        return data([
          {
            store: "main",
            total: 1000 * 1024 ** 3,
            used: 250 * 1024 ** 3,
            avail: 750 * 1024 ** 3,
            "estimated-full-date": 1830297600,
          },
        ]);
      if (path === "/admin/datastore/main/groups")
        return data([
          { "backup-type": "vm", "backup-id": "105", "last-backup": 1791000000, "backup-count": 7 },
          {
            "backup-type": "ct",
            "backup-id": "110",
            "last-backup": 1790000000,
            "backup-count": 3,
            comment: "jellyfin",
          },
        ]);
      if (path === "/admin/datastore/main/snapshots" && req.method === "GET")
        return data([
          {
            "backup-type": "vm",
            "backup-id": "105",
            "backup-time": 1790000000,
            size: 2 * 1024 ** 3,
            verification: { state: "ok" },
          },
          {
            "backup-type": "vm",
            "backup-id": "105",
            "backup-time": 1791000000,
            size: 3 * 1024 ** 3,
            protected: true,
          },
        ]);
      if (path === "/admin/datastore/main/snapshots" && req.method === "DELETE") return data(null);
      if (path === "/admin/datastore/main/verify") return data("UPID:pbs:verify");
      if (path === "/nodes/localhost/tasks")
        return data([
          {
            upid: "u1",
            worker_type: "backup",
            worker_id: "main:vm/105",
            starttime: 1791000000,
            endtime: 1791000100,
            status: "OK",
          },
          { upid: "u2", worker_type: "verify", starttime: 1791000200 },
        ]);
      return new Response(null, { status: 403, statusText: "Forbidden" });
    },
  });
});
afterAll(() => server.stop(true));

const env = () => ({
  PBS_URL: `https://127.0.0.1:${server.port}`,
  PBS_TOKEN_ID: "hatbot@pbs!brain",
  PBS_TOKEN_SECRET: "s3cret",
  PBS_TLS_FINGERPRINT: FINGERPRINT,
});
const call: CallContext = { task: { id: 1, tainted: false }, signal: new AbortController().signal };

async function started() {
  const t = await testApp(new FakeModel(), new FakeModel(), {}, [pbsPlugin], env());
  await t.plugins.update("pbs", { enabled: true });
  const pbs = (name: string) => {
    const found = t.plugins.tools().find((x) => x.name === name);
    if (!found) throw new Error(`no tool ${name}`);
    return found;
  };
  return { t, pbs };
}

test("without a token it needs setup", async () => {
  const t = await testApp(new FakeModel(), new FakeModel(), {}, [pbsPlugin], {});
  expect((await t.plugins.update("pbs", { enabled: true })).state).toBe("needs_setup");
});

test("reads datastores, backups oldest first, snapshots newest first, and tasks", async () => {
  const { t, pbs } = await started();
  expect(await t.plugins.test("pbs")).toBe(
    "Connected; it sees 1 datastore. Its token may verify backups in main, and collect garbage and delete backups in main; deleting a backup needs approval (the safety review or the owner).",
  );
  expect(seen.at(-1)?.auth).toBe("PBSAPIToken=hatbot@pbs!brain:s3cret");

  expect(await pbs("pbs_datastores").run({}, call)).toBe(
    "main: 250.0 GiB of 1000.0 GiB used (25%), 750.0 GiB free, full around 2028-01-01",
  );
  expect(await pbs("pbs_backups").run({ store: "main" }, call)).toBe(
    "ct/110 (jellyfin): 3 snapshots, last 2026-09-21 14:13\nvm/105: 7 snapshots, last 2026-10-03 04:00",
  );
  const snaps = await pbs("pbs_snapshots").run({ store: "main", type: "vm", id: "105" }, call);
  expect(snaps.split("\n")).toEqual([
    "2026-10-03 04:00 (backup-time 1791000000): 3.0 GiB, not verified, protected",
    "2026-09-21 14:13 (backup-time 1790000000): 2.0 GiB, verify ok",
  ]);
  expect(seen.at(-1)?.path).toBe("/admin/datastore/main/snapshots?backup-type=vm&backup-id=105");
  expect(await pbs("pbs_tasks").run({ errors_only: false, limit: 30 }, call)).toBe(
    "2026-10-03 04:00 backup main:vm/105: OK\n2026-10-03 04:03 verify: running",
  );
});

test("verifying runs; deleting a backup asks first and sends the snapshot's id", async () => {
  const { pbs } = await started();
  const v = (name: string, input: unknown) => verdictFor(pbs(name), input, call);
  expect(v("pbs_verify", { store: "main" }).action).toBe("allow");
  expect(v("pbs_garbage_collect", { store: "main" }).action).toBe("allow");
  const del = { store: "main", type: "vm", id: "105", time: 1790000000 };
  expect(v("pbs_delete_snapshot", del)).toMatchObject({ action: "ask", kind: "delete" });

  expect(await pbs("pbs_verify").run({ store: "main", type: "vm", id: "105" }, call)).toBe(
    "Started verifying (task UPID:pbs:verify).",
  );
  expect(seen.at(-1)?.body).toBe("backup-type=vm&backup-id=105");
  expect(await pbs("pbs_delete_snapshot").run(del, call)).toBe(
    "Deleted vm/105/2026-09-21T14:13:20Z.",
  );
  expect(seen.at(-1)).toMatchObject({
    method: "DELETE",
    path: "/admin/datastore/main/snapshots?backup-type=vm&backup-id=105&backup-time=1790000000",
  });
});

test("it offers only what its token may do, and checks again when it couldn't", async () => {
  const full = privs;
  try {
    privs = { "Datastore.Audit": true };
    const look = await started();
    expect(look.t.plugins.tools().map((x) => x.name)).toEqual([
      "pbs_datastores",
      "pbs_backups",
      "pbs_snapshots",
      "pbs_tasks",
    ]);
    expect(look.t.plugins.guidance()).toContain(
      "Its token may only look: verifying needs the DatastoreReader role",
    );

    privs = { "Datastore.Audit": true, "Datastore.Verify": true, "Datastore.Read": true };
    const verify = await started();
    const names = verify.t.plugins.tools().map((x) => x.name);
    expect(names).toContain("pbs_verify");
    expect(names).not.toContain("pbs_garbage_collect");
    expect(names).not.toContain("pbs_delete_snapshot");

    // The check failed: it only looks, Settings says why, and it checks again.
    privs = null;
    const t = await testApp(new FakeModel(), new FakeModel(), {}, [pbsPlugin], env());
    t.plugins.retryMs = [20];
    const info = await t.plugins.update("pbs", { enabled: true });
    expect(info.state).toBe("ready");
    expect(info.message).toContain("Couldn't check what its token may do, so it only looks");
    expect(t.plugins.tools().some((x) => x.name === "pbs_verify")).toBe(false);
    privs = full;
    await waitFor(() => t.plugins.tools().some((x) => x.name === "pbs_delete_snapshot"));
    expect(t.plugins.get("pbs")?.message).toBeNull();

    // The test button checks again, and Settings is told what it offers now.
    privs = { "Datastore.Audit": true };
    const before = t.events.length;
    await t.plugins.test("pbs");
    const updated = t.events
      .slice(before)
      .flatMap((e) => (e.type === "plugin.updated" ? [e.plugin] : []));
    expect(updated.at(-1)?.tools.map((x) => x.name)).toEqual(
      look.t.plugins.tools().map((x) => x.name),
    );
  } finally {
    privs = full;
  }
});

test("a certificate that doesn't match the pin stops it", async () => {
  const t = await testApp(new FakeModel(), new FakeModel(), {}, [pbsPlugin], {
    ...env(),
    PBS_TLS_FINGERPRINT: FINGERPRINT.replace("D7", "AA"),
  });
  await t.plugins.update("pbs", { enabled: true });
  await expect(t.plugins.test("pbs")).rejects.toThrow(
    "Proxmox Backup Server's certificate doesn't match the pinned fingerprint. It now shows D7:6A:C1:55:98:6E:33:E6:73:98:B6:92:28:50:A5:F7:F0:69:D9:96:AD:CC:64:25:0D:DA:0F:BC:7A:4C:40:D0. If its certificate was renewed, put that in PBS_TLS_FINGERPRINT in /etc/hatbot/pbs.env",
  );
});
