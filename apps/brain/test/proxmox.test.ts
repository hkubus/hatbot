import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Proxmox } from "../src/proxmox";
import { setUpOwner, testApp } from "./helpers";

const FINGERPRINT =
  "D7:6A:C1:55:98:6E:33:E6:73:98:B6:92:28:50:A5:F7:F0:69:D9:96:AD:CC:64:25:0D:DA:0F:BC:7A:4C:40:D0";
const fixtures = join(import.meta.dir, "fixtures");
const seen: { method: string; path: string; auth: string | null; body: string }[] = [];
let server: ReturnType<typeof Bun.serve>;

// A stand-in for pveproxy with a self-signed certificate.
beforeAll(() => {
  server = Bun.serve({
    port: 0,
    tls: {
      cert: Bun.file(join(fixtures, "pve-cert.pem")),
      key: Bun.file(join(fixtures, "pve-key.pem")),
    },
    async fetch(req) {
      const path = new URL(req.url).pathname;
      seen.push({
        method: req.method,
        path,
        auth: req.headers.get("authorization"),
        body: await req.text(),
      });
      const data = (d: unknown) => Response.json({ data: d });
      if (path === "/api2/json/nodes/pve/lxc/126/snapshot") {
        // Chunked, as pveproxy may send it.
        const json = JSON.stringify({
          data: [
            { name: "current", description: "You are here!" },
            {
              name: "nightly_20261007",
              snaptime: 1791345600,
              description: "Hatbot nightly snapshot\n",
            },
            {
              name: "nightly_20261008",
              snaptime: 1791432000,
              description: "Hatbot nightly snapshot\n",
            },
          ],
        });
        return new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode(json.slice(0, 40)));
              c.enqueue(new TextEncoder().encode(json.slice(40)));
              c.close();
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (path === "/api2/json/nodes/pve/lxc/126/snapshot/nightly_20261008/rollback")
        return data("UPID:pve:1:2:3:vzrollback:126:hatbot@pve!brain:");
      if (path.startsWith("/api2/json/nodes/pve/tasks/"))
        return data({ status: "stopped", exitstatus: "OK" });
      return new Response(null, { status: 403, statusText: "Forbidden" });
    },
  });
});
afterAll(() => server.stop(true));

const env = (fingerprint = FINGERPRINT) => ({
  PROXMOX_URL: `https://127.0.0.1:${server.port}`,
  PROXMOX_NODE: "pve",
  PROXMOX_TOKEN_ID: "hatbot@pve!brain",
  PROXMOX_TOKEN_SECRET: "s3cret",
  PROXMOX_TLS_FINGERPRINT: fingerprint,
  HATBOT_DESKTOP_ID: "126",
});

describe("Proxmox", () => {
  test("lists the desktop's snapshots over the pinned connection, newest first", async () => {
    const snaps = await new Proxmox(env()).desktopSnapshots();
    expect(snaps.map((s) => s.name)).toEqual(["nightly_20261008", "nightly_20261007"]);
    expect(snaps[0]?.description).toBe("Hatbot nightly snapshot");
    expect(seen.at(-1)?.auth).toBe("PVEAPIToken=hatbot@pve!brain=s3cret");
  });

  test("refuses a certificate that doesn't match the pin, before sending the token", async () => {
    const before = seen.length;
    const wrong = FINGERPRINT.replace("D7", "D8");
    await expect(new Proxmox(env(wrong)).desktopSnapshots()).rejects.toThrow(/pinned fingerprint/);
    await Bun.sleep(50);
    expect(seen.length).toBe(before);
  });

  test("rolls back, starting the desktop again, and waits for the task", async () => {
    const pve = new Proxmox(env());
    pve.pollMs = 5;
    await pve.rollbackDesktop("nightly_20261008");
    const post = seen.find((s) => s.method === "POST");
    expect(post?.body).toBe("start=1");
    expect(seen.at(-1)?.path).toContain("/tasks/UPID");
  });

  test("passes Proxmox's error on", async () => {
    const pve = new Proxmox(env());
    await expect(pve.rollbackDesktop("nightly_19990101")).rejects.toThrow(/^Proxmox: /);
    await expect(pve.rollbackDesktop("../../etc")).rejects.toThrow(/Not a snapshot name/);
  });

  test("isn't configured without a fingerprint", () => {
    expect(new Proxmox({ ...env(), PROXMOX_TLS_FINGERPRINT: "" }).configured).toBe(false);
  });
});

describe("Roll back desktop", () => {
  test("lists snapshots and rolls back when nothing is using the desktop", async () => {
    const t = await testApp(undefined, undefined, env());
    const { cookie } = await setUpOwner(t);
    const list = await t.call("GET", "/desktop/snapshots", undefined, { cookie });
    expect(((await list.json()) as { snapshots: unknown[] }).snapshots).toHaveLength(2);

    const res = await t.call("POST", "/desktop/rollback", { name: "nightly_20261008" }, { cookie });
    expect(res.status).toBe(200);
    expect(t.tasks.lane.holderId).toBeNull();
  });

  test("refuses while a task or you are using the desktop", async () => {
    const t = await testApp(undefined, undefined, env());
    const { cookie } = await setUpOwner(t);
    const rollback = () =>
      t.call("POST", "/desktop/rollback", { name: "nightly_20261008" }, { cookie });

    await t.call("POST", "/desktop/takeover", undefined, { cookie });
    expect(((await (await rollback()).json()) as { error: string }).error).toMatch(/Hand/);
    await t.call("POST", "/desktop/handback", undefined, { cookie });

    t.db.run(
      "INSERT INTO tasks (title, goal, origin, lane, model, status, budget_usd) VALUES ('x', 'x', 'chat', 'screen', 'm', 'waiting_approval', 1)",
    );
    const res = await rollback();
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/Cancel it first/);
  });

  test("says when Proxmox isn't set up", async () => {
    const t = await testApp();
    const { cookie } = await setUpOwner(t);
    const res = await t.call("GET", "/desktop/snapshots", undefined, { cookie });
    expect(await res.json()).toEqual({ configured: false, snapshots: [] });
  });
});
