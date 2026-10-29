import { expect, test } from "bun:test";
import { join } from "node:path";
import { Proxmox, pinnedRequest } from "@hatbot/plugin-proxmox/client";
import { signIn, testApp } from "./helpers";
import { fakeApi, fixtures, PVE_FINGERPRINT } from "./plugin-helpers";

const pve = fakeApi(
  (_req, url) => {
    const path = url.pathname;
    if (path === "/api2/json/nodes/pve/lxc/126/snapshot") {
      const json = JSON.stringify({
        data: [
          { name: "current", description: "You are here!" },
          { name: "nightly_20261007", snaptime: 1791345600, description: "Hatbot nightly\n" },
          { name: "nightly_20261008", snaptime: 1791432000, description: "Hatbot nightly\n" },
        ],
      });
      // Chunked, as pveproxy may send it.
      const bytes = new TextEncoder().encode(json);
      return new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(bytes.slice(0, 40));
            c.enqueue(bytes.slice(40));
            c.close();
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    if (path === "/api2/json/nodes/pve/lxc/126/snapshot/nightly_20261008/rollback")
      return { data: "UPID:pve:1:2:3:vzrollback:126:hatbot@pve!brain:" };
    if (path.startsWith("/api2/json/nodes/pve/tasks/"))
      return { data: { status: "stopped", exitstatus: "OK" } };
    return new Response(null, { status: 403, statusText: "Forbidden" });
  },
  { tls: "pve" },
);
// Its certificate is signed by fixtures/test-ca.pem for "localhost".
const signed = fakeApi(() => ({ data: "ok" }), { tls: "ca-signed" });

const env = (fingerprint = PVE_FINGERPRINT) => ({
  PROXMOX_URL: pve.url,
  PROXMOX_NODE: "pve",
  PROXMOX_TOKEN_ID: "hatbot@pve!brain",
  PROXMOX_TOKEN_SECRET: "s3cret",
  PROXMOX_TLS_FINGERPRINT: fingerprint,
  HATBOT_DESKTOP_ID: "126",
});

test("Settings lists the desktop's snapshots, newest first, and rolls back to one", async () => {
  const t = await testApp(undefined, undefined, env());
  const { cookie } = signIn(t);
  const list = await t.call("GET", "/desktop/snapshots", undefined, { cookie });
  const { snapshots } = (await list.json()) as { snapshots: { name: string }[] };
  expect(snapshots.map((s) => s.name)).toEqual(["nightly_20261008", "nightly_20261007"]);
  expect(pve.seen[0]?.auth).toBe("PVEAPIToken=hatbot@pve!brain=s3cret");

  const rollback = (name: string) => t.call("POST", "/desktop/rollback", { name }, { cookie });
  expect((await rollback("nightly_20261008")).status).toBe(200);
  expect(pve.seen.find((s) => s.method === "POST")?.body).toBe("start=1");
  expect(pve.seen.at(-1)?.path).toContain("/tasks/UPID");
  expect(t.tasks.lane.holderId).toBeNull();
  const before = pve.seen.length;
  expect((await rollback("../../etc")).status).toBe(400);
  expect(pve.seen.length).toBe(before);
});

test("rolling back is refused while you or a task use the desktop", async () => {
  const t = await testApp(undefined, undefined, env());
  const { cookie } = signIn(t);
  const rollback = () =>
    t.call("POST", "/desktop/rollback", { name: "nightly_20261008" }, { cookie });
  await t.call("POST", "/desktop/takeover", undefined, { cookie });
  expect((await rollback()).status).toBe(409);
  await t.call("POST", "/desktop/handback", undefined, { cookie });
  t.db.run(
    "INSERT INTO tasks (title, goal, origin, lane, model, status, budget_usd) VALUES ('x', 'x', 'chat', 'screen', 'm', 'waiting_approval', 1)",
  );
  expect((await rollback()).status).toBe(409);
  expect(pve.seen.some((s) => s.method === "POST")).toBe(false);
});

test("only the pinned certificate, or a trusted CA's for the host's name, gets the token", async () => {
  const wrong = PVE_FINGERPRINT.replace("D7", "D8");
  await expect(new Proxmox(env(wrong)).desktopSnapshots()).rejects.toThrow(PVE_FINGERPRINT);
  expect(pve.seen).toEqual([]);
  expect(new Proxmox({ ...env(), PROXMOX_TLS_FINGERPRINT: "" }).configured).toBe(false);

  const api = {
    name: "Proxmox",
    host: "localhost",
    port: signed.port,
    fingerprint: PVE_FINGERPRINT,
    setting: "PROXMOX_TLS_FINGERPRINT in /etc/hatbot/proxmox.env",
    auth: "PVEAPIToken=x=y",
  };
  // Not a CA the system trusts: the pin decides, and it doesn't match.
  await expect(pinnedRequest(api, "GET", "/version")).rejects.toThrow(/pinned fingerprint/);
  const ca = await Bun.file(join(fixtures, "test-ca.pem")).text();
  expect(await pinnedRequest({ ...api, ca }, "GET", "/version")).toBe("ok");
  // The CA's word counts only for the name it signed.
  await expect(pinnedRequest({ ...api, ca, host: "127.0.0.2" }, "GET", "/version")).rejects.toThrow(
    /pinned fingerprint/,
  );
});
