import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import type { Task } from "@hatbot/shared";
import type { CallContext } from "../src/plugins/plugin";
import { proxmoxPlugin } from "../src/plugins/proxmox";
import { verdictFor } from "../src/plugins/registry";
import { FakeModel, toolUse } from "./fake-model";
import { testApp, waitFor } from "./helpers";

const FINGERPRINT =
  "D7:6A:C1:55:98:6E:33:E6:73:98:B6:92:28:50:A5:F7:F0:69:D9:96:AD:CC:64:25:0D:DA:0F:BC:7A:4C:40:D0";
const fixtures = join(import.meta.dir, "fixtures");
const posts: { path: string; body: string }[] = [];
let server: ReturnType<typeof Bun.serve>;

const GUESTS = [
  {
    id: "lxc/105",
    vmid: 105,
    name: "jellyfin",
    type: "lxc",
    node: "pve",
    status: "running",
    cpu: 0.05,
    maxcpu: 2,
    mem: 512 * 2 ** 20,
    maxmem: 2 * 2 ** 30,
    disk: 3 * 2 ** 30,
    maxdisk: 8 * 2 ** 30,
    uptime: 90061,
    tags: "media;docker",
  },
  {
    id: "qemu/200",
    vmid: 200,
    name: "router",
    type: "qemu",
    node: "pve",
    status: "running",
    cpu: 0.01,
    maxcpu: 1,
    mem: 2 ** 29,
    maxmem: 2 ** 30,
    uptime: 3600,
  },
  {
    id: "lxc/125",
    vmid: 125,
    name: "hatbot-brain",
    type: "lxc",
    node: "pve",
    status: "running",
    pool: "hatbot",
    maxcpu: 2,
  },
  {
    id: "lxc/900",
    vmid: 900,
    name: "debian-template",
    type: "lxc",
    node: "pve",
    status: "stopped",
    template: 1,
  },
];

// A stand-in for pveproxy with a self-signed certificate.
beforeAll(() => {
  server = Bun.serve({
    port: 0,
    tls: {
      cert: Bun.file(join(fixtures, "pve-cert.pem")),
      key: Bun.file(join(fixtures, "pve-key.pem")),
    },
    async fetch(req) {
      const path = new URL(req.url).pathname.replace("/api2/json", "");
      const data = (d: unknown) => Response.json({ data: d });
      if (req.method === "POST") {
        posts.push({ path, body: await req.text() });
        if (/\/status\/(start|reboot|shutdown|stop)$|\/snapshot$/.test(path))
          return data(`UPID:pve:00001:00002:00003:vzreboot:105:hatbot@pve!brain:`);
      }
      if (path === "/cluster/resources") return data(GUESTS);
      if (path === "/nodes/pve/lxc/105/status/current")
        return data({
          status: "running",
          uptime: 90061,
          cpu: 0.05,
          cpus: 2,
          mem: 2 ** 29,
          maxmem: 2 ** 31,
          netin: 2 ** 20,
          netout: 2 ** 21,
        });
      if (path === "/nodes/pve/lxc/105/config")
        return data({ hostname: "jellyfin", cores: 2, memory: 2048, onboot: 1, digest: "abc" });
      if (path === "/nodes/pve/status")
        return data({
          cpu: 0.12,
          loadavg: ["0.5", "0.4", "0.3"],
          memory: { used: 8 * 2 ** 30, total: 16 * 2 ** 30 },
          rootfs: { used: 10 * 2 ** 30, total: 100 * 2 ** 30 },
          uptime: 864000,
          pveversion: "pve-manager/9.1.2",
        });
      if (path === "/nodes/pve/storage")
        return data([
          {
            storage: "local-zfs",
            type: "zfspool",
            active: 1,
            used: 50 * 2 ** 30,
            total: 200 * 2 ** 30,
          },
        ]);
      if (path === "/cluster/tasks")
        return data([
          {
            type: "vzdump",
            id: "105",
            user: "root@pam",
            status: "OK",
            starttime: 1791345600,
            endtime: 1791345700,
          },
          {
            type: "vzdump",
            id: "200",
            user: "root@pam",
            status: "job errors",
            starttime: 1791345800,
            endtime: 1791345900,
          },
        ]);
      if (path.startsWith("/nodes/pve/tasks/"))
        return data({ status: "stopped", exitstatus: "OK" });
      return new Response(null, { status: 403, statusText: "Forbidden" });
    },
  });
});
afterAll(() => server.stop(true));

const env = () => ({
  PROXMOX_URL: `https://127.0.0.1:${server.port}`,
  PROXMOX_NODE: "pve",
  PROXMOX_TOKEN_ID: "hatbot@pve!brain",
  PROXMOX_TOKEN_SECRET: "s3cret",
  PROXMOX_TLS_FINGERPRINT: FINGERPRINT,
  HATBOT_BRAIN_ID: "125",
  HATBOT_DESKTOP_ID: "126",
});

async function started(model = new FakeModel(), config?: unknown) {
  const t = await testApp(new FakeModel(), model, {}, [proxmoxPlugin], env());
  if (config) await t.plugins.update("proxmox", { config });
  await t.plugins.update("proxmox", { enabled: true });
  const pveTool = (name: string) => {
    const found = t.plugins.tools().find((x) => x.name === name);
    if (!found) throw new Error(`no tool ${name}`);
    return found;
  };
  return { t, pveTool };
}

const call: CallContext = { task: { id: 1, tainted: false }, signal: new AbortController().signal };

test("without the token it needs setup", async () => {
  const t = await testApp(new FakeModel(), new FakeModel(), {}, [proxmoxPlugin], {});
  const info = await t.plugins.update("proxmox", { enabled: true });
  expect(info.state).toBe("needs_setup");
  expect(info.message).toContain("host-setup.sh");
});

test("reads guests, a guest, the host and recent tasks", async () => {
  const { t, pveTool } = await started();
  expect(
    t.plugins
      .tools()
      .filter((x) => x.access === "read")
      .map((x) => x.name),
  ).toEqual(["proxmox_guests", "proxmox_guest", "proxmox_node", "proxmox_tasks"]);
  const guests = await pveTool("proxmox_guests").run({}, call);
  expect(guests).toContain(
    "CT 105 (jellyfin): running, up 1d 1h, CPU 5% of 2, memory 512 MiB of 2.0 GiB, disk 3.0 GiB of 8.0 GiB, tags media, docker",
  );
  expect(guests).toContain("VM 200 (router): running");
  expect(guests).not.toContain("template");

  const one = await pveTool("proxmox_guest").run({ vmid: 105 }, call);
  expect(one).toContain("CT 105 (jellyfin): running");
  expect(one).toContain("onboot: 1");
  expect(one).not.toContain("digest");

  const node = await pveTool("proxmox_node").run({}, call);
  expect(node).toContain("pve-manager/9.1.2");
  expect(node).toContain("local-zfs (zfspool): 50 GiB of 200 GiB (25%)");

  const failed = await pveTool("proxmox_tasks").run({ failed_only: true }, call);
  expect(failed).toContain("vzdump 200 by root@pam: job errors");
  expect(failed).not.toContain("vzdump 105");

  expect(await t.plugins.test("proxmox")).toBe("Connected to pve: 3 guests, 3 running.");
});

test("reboot runs right away; shutdown, careful guests and the desktop ask; the brain is refused", async () => {
  const { pveTool } = await started(new FakeModel(), { careful: [200] });
  const power = pveTool("proxmox_power");
  const v = (input: unknown, tainted = false) =>
    verdictFor(power, input, { ...call, task: { id: 1, tainted } });
  expect(v({ vmid: 105, action: "reboot" }).action).toBe("allow");
  expect(v({ vmid: 105, action: "start" }).action).toBe("allow");
  expect(v({ vmid: 105, action: "shutdown" }).action).toBe("ask");
  expect(v({ vmid: 200, action: "reboot" }).action).toBe("ask");
  expect(v({ vmid: 126, action: "reboot" }).action).toBe("ask");
  expect(v({ vmid: 125, action: "reboot" }).action).toBe("block");
  // Tainted: even a reboot asks.
  expect(v({ vmid: 105, action: "reboot" }, true).action).toBe("ask");

  const out = await power.run({ vmid: 105, action: "reboot" }, call);
  expect(out).toBe("Reboot CT 105 (jellyfin): done. It's running now.");
  expect(posts.at(-1)?.path).toBe("/nodes/pve/lxc/105/status/reboot");
  expect(power.describe?.({ vmid: 105, action: "reboot" })).toBe("Reboot CT 105 (jellyfin)");

  await expect(power.run({ vmid: 404, action: "start" }, call)).rejects.toThrow(
    "There's no guest 404.",
  );
});

test("an alert task reboots a guest and reports; shutting down waits for you", async () => {
  const work = new FakeModel([
    { content: [toolUse("proxmox_guests", {})] },
    { content: [toolUse("proxmox_power", { vmid: 105, action: "reboot" })] },
    { content: [toolUse("proxmox_power", { vmid: 200, action: "shutdown" })] },
    {
      content: [
        toolUse("finish_task", { outcome: "done", summary: "Rebooted jellyfin.", notify: true }),
      ],
    },
  ]);
  const { t } = await started(work);
  const task = t.tasks.createBackgroundTask({
    title: "Jellyfin is down",
    goal: "Investigate and fix",
    origin: "alert",
    source: "Uptime Kuma",
    runKey: "kuma:1:105",
    payload: "{}",
    trusted: true,
  }) as Task;
  const approval = await waitFor(() => t.approvals.list(true)[0]);
  expect(approval.summary).toBe("Shut down VM 200 (router)");
  t.approvals.decide(approval.id, "deny", "web");
  await waitFor(() => t.tasks.get(task.id)?.finishedAt);
  expect(posts.some((p) => p.path === "/nodes/pve/lxc/105/status/reboot")).toBe(true);
  expect(posts.some((p) => p.path.endsWith("/200/status/shutdown"))).toBe(false);
  const steps = t.tasks.steps(task.id).map((s) => s.detail);
  expect(steps).toContain("Reboot CT 105 (jellyfin)");
  // The system prompt says which guest is the brain.
  expect(JSON.stringify(work.requests[0]?.system)).toContain("Guest 125 is Hatbot's own brain");
});
