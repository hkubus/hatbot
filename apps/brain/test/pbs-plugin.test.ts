import { beforeEach, expect, test } from "bun:test";
import { pbsPlugin } from "../src/plugins/pbs";
import { FakeModel, toolUse } from "./fake-model";
import { waitFor } from "./helpers";
import {
  ended,
  fakeApi,
  finish,
  PVE_FINGERPRINT,
  pluginApp,
  scheduled,
  stopPluginsAfterEach,
} from "./plugin-helpers";

stopPluginsAfterEach();

const FULL = { "Datastore.Audit": true, "Datastore.Verify": true, "Datastore.Modify": true };
/** What the token may do on the datastore "main"; null fails, as an old token's check would. */
let privs: Record<string, boolean> | null = FULL;
beforeEach(() => {
  privs = FULL;
});

// A stand-in for the backup server's proxy, with a self-signed certificate.
const api = fakeApi(
  (req, url) => {
    const path = url.pathname.replace("/api2/json", "");
    if (path === "/access/permissions" && url.searchParams.get("path") === "/datastore/main")
      return privs
        ? { data: { "/datastore/main": privs } }
        : new Response(null, { status: 500, statusText: "Internal Server Error" });
    if (path === "/status/datastore-usage")
      return { data: [{ store: "main", total: 1000, used: 250, avail: 750 }] };
    if (path === "/admin/datastore/main/snapshots" && req.method === "DELETE")
      return { data: null };
    if (path === "/admin/datastore/main/verify") return { data: "UPID:pbs:verify" };
    return new Response(null, { status: 403, statusText: "Forbidden" });
  },
  { tls: "pve" },
);
const env = {
  PBS_URL: api.url,
  PBS_TOKEN_ID: "hatbot@pbs!brain",
  PBS_TOKEN_SECRET: "s3cret",
  PBS_TLS_FINGERPRINT: PVE_FINGERPRINT,
};
const names = (t: { plugins: { tools: () => { name: string }[] } }) =>
  t.plugins.tools().map((x) => x.name);

test("a task verifies right away; deleting a backup waits for approval and names the snapshot", async () => {
  const work = new FakeModel([
    { content: [toolUse("pbs_verify", { store: "main", type: "vm", id: "105" })] },
    {
      content: [
        toolUse("pbs_delete_snapshot", { store: "main", type: "vm", id: "105", time: 1790000000 }),
      ],
    },
    finish(),
  ]);
  const t = await pluginApp(pbsPlugin, env, { work });
  const task = scheduled(t);
  const approval = await waitFor(() => t.approvals.list(true)[0]);
  expect(approval.kind).toBe("delete");
  expect(api.seen.find((s) => s.path === "/api2/json/admin/datastore/main/verify")).toMatchObject({
    auth: "PBSAPIToken=hatbot@pbs!brain:s3cret",
    body: "backup-type=vm&backup-id=105",
  });
  expect(api.seen.some((s) => s.method === "DELETE")).toBe(false);
  t.approvals.decide(approval.id, "approve", "web");
  await ended(t, task.id);
  expect(api.seen.find((s) => s.method === "DELETE")?.path).toBe(
    "/api2/json/admin/datastore/main/snapshots?backup-type=vm&backup-id=105&backup-time=1790000000",
  );
});

test("it offers only what its token may do, and checks again when it couldn't or on Test", async () => {
  privs = { "Datastore.Audit": true };
  const look = await pluginApp(pbsPlugin, env);
  const looking = ["pbs_datastores", "pbs_backups", "pbs_snapshots", "pbs_tasks"];
  expect(names(look)).toEqual(looking);

  // The check failed: it only looks, Settings says why, and it checks again.
  privs = null;
  const t = await pluginApp(pbsPlugin, env);
  expect(t.info.message).toContain("Couldn't check what its token may do");
  expect(names(t)).toEqual(looking);
  t.plugins.retryMs = [5];
  await t.plugins.update("pbs", { enabled: true }); // started again, to try again sooner
  privs = FULL;
  await waitFor(() => names(t).includes("pbs_delete_snapshot"));
  expect(t.plugins.get("pbs")?.message).toBeNull();

  // The test button checks again, and Settings is told what it offers now.
  privs = { "Datastore.Audit": true };
  const before = t.events.length;
  await t.plugins.test("pbs");
  const updated = t.events
    .slice(before)
    .flatMap((e) => (e.type === "plugin.updated" ? [e.plugin] : []));
  expect(updated.at(-1)?.tools.map((x) => x.name)).toEqual(looking);
});
