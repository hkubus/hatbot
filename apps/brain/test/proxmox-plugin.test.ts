import { expect, test } from "bun:test";
import { proxmoxPlugin } from "../src/plugins/proxmox";
import { verdictFor } from "../src/plugins/registry";
import { FakeModel, toolUse } from "./fake-model";
import { waitFor } from "./helpers";
import {
  call,
  ended,
  fakeApi,
  finish,
  PVE_FINGERPRINT,
  pluginApp,
  stopPluginsAfterEach,
  tainted,
} from "./plugin-helpers";

stopPluginsAfterEach();

const GUESTS = [
  { vmid: 105, name: "jellyfin", type: "lxc", node: "pve", status: "running", maxcpu: 2 },
  { vmid: 200, name: "router", type: "qemu", node: "pve", status: "running", maxcpu: 1 },
  { vmid: 125, name: "hatbot-brain", type: "lxc", node: "pve", status: "running", tags: "hatbot" },
  { vmid: 900, name: "debian-template", type: "lxc", node: "pve", status: "stopped", template: 1 },
];

// A stand-in for pveproxy with a self-signed certificate.
const api = fakeApi(
  (req, url) => {
    const path = url.pathname.replace("/api2/json", "");
    if (req.method === "POST" && /\/status\/(start|reboot|shutdown|stop)$/.test(path))
      return { data: "UPID:pve:00001:00002:00003:vzreboot:105:hatbot@pve!brain:" };
    if (path === "/cluster/resources") return { data: GUESTS };
    if (path.startsWith("/nodes/pve/tasks/"))
      return { data: { status: "stopped", exitstatus: "OK" } };
    return new Response(null, { status: 403, statusText: "Forbidden" });
  },
  { tls: "pve" },
);
const posts = () => api.seen.filter((s) => s.method === "POST").map((s) => s.path);

const env = (brain: string | null = "125") => ({
  PROXMOX_URL: api.url,
  PROXMOX_NODE: "pve",
  PROXMOX_TOKEN_ID: "hatbot@pve!brain",
  PROXMOX_TOKEN_SECRET: "s3cret",
  PROXMOX_TLS_FINGERPRINT: PVE_FINGERPRINT,
  HATBOT_DESKTOP_ID: "126",
  ...(brain ? { HATBOT_BRAIN_ID: brain } : {}),
});

test("a task reads the guests and reboots one; shutting one down waits for you", async () => {
  const work = new FakeModel([
    { content: [toolUse("proxmox_guests", {})] },
    { content: [toolUse("proxmox_power", { vmid: 105, action: "reboot" })] },
    { content: [toolUse("proxmox_power", { vmid: 200, action: "shutdown" })] },
    finish("Rebooted jellyfin."),
  ]);
  const t = await pluginApp(proxmoxPlugin, env(), { work });
  const task = t.tasks.createBackgroundTask({
    title: "Jellyfin is down",
    goal: "Investigate and fix",
    origin: "alert",
    source: "Uptime Kuma",
    payload: "{}",
    trusted: true,
  });
  const approval = await waitFor(() => t.approvals.list(true)[0]);
  expect(approval.summary).toBe("Shut down VM 200 (router)");
  t.approvals.decide(approval.id, "deny", "web");
  await ended(t, task?.id as number);
  expect(posts()).toEqual(["/api2/json/nodes/pve/lxc/105/status/reboot"]);
  expect(api.seen[0]?.auth).toBe("PVEAPIToken=hatbot@pve!brain=s3cret");
  const guests = JSON.stringify(work.requests[1]?.messages);
  expect(guests).toContain("CT 105 (jellyfin): running");
  expect(guests).not.toContain("debian-template");
  // The system prompt says which guest is the brain, without calling it Hatbot: a bot has its own name.
  expect(JSON.stringify(work.requests[0]?.system)).toContain("Guest 125 is the brain you run on");
  expect(t.plugins.guidance()).not.toContain("Hatbot");
});

test("power: careful guests, shutdowns and the desktop ask; the brain is refused, by id or tag", async () => {
  const t = await pluginApp(proxmoxPlugin, env(), { config: { careful: [200] } });
  const power = t.tool("proxmox_power");
  const v = (vmid: number, action: string, ctx = call) => verdictFor(power, { vmid, action }, ctx);
  expect(v(105, "reboot").action).toBe("allow");
  expect(v(105, "reboot", tainted).action).toBe("ask");
  expect(v(105, "shutdown").action).toBe("ask");
  expect(v(200, "reboot")).toMatchObject({ action: "ask", always: true });
  expect(v(126, "reboot").action).toBe("ask");
  expect(v(125, "reboot").action).toBe("block");

  // The brain moved to an id the env doesn't know yet: its tag still says what it is.
  const moved = await pluginApp(proxmoxPlugin, env("300"));
  const movedPower = moved.tool("proxmox_power");
  await expect(movedPower.run({ vmid: 125, action: "reboot" }, call)).rejects.toThrow(
    "tagged hatbot",
  );
  expect(posts()).toEqual([]);
  expect(verdictFor(movedPower, { vmid: 125, action: "reboot" }, call).action).toBe("block");

  // Without HATBOT_BRAIN_ID nothing is powered.
  const unknown = await pluginApp(proxmoxPlugin, env(null));
  expect(unknown.plugins.tools().some((x) => x.name === "proxmox_power")).toBe(false);
});
