// The host's certificate is self-signed, so the connection is pinned to its SHA-256 fingerprint. A
// certificate from a public CA for the host's name is accepted too, so one that renews itself (ACME)
// keeps working. Bun's fetch skips checkServerIdentity when rejectUnauthorized is off, so requests go
// over a node:tls socket checked here first.
import { request } from "node:http";
import { isIP } from "node:net";
import { checkServerIdentity, connect } from "node:tls";
import { PluginError } from "@hatbot/plugin-sdk";

export type Snapshot = { name: string; description: string; createdAt: string | null };

const normalizeFp = (fp: string) => fp.replace(/:/g, "").toUpperCase();

export type PinnedApi = {
  name: string;
  host: string;
  port: number;
  /** SHA-256, colons optional. */
  fingerprint: string;
  setting: string;
  auth: string;
  /** For tests. */
  ca?: string;
};

export async function pinnedRequest(
  api: PinnedApi,
  method: "GET" | "POST" | "DELETE",
  path: string,
  form?: Record<string, string>,
): Promise<unknown> {
  const body = form ? new URLSearchParams(form).toString() : "";
  const socket = connect({
    host: api.host,
    port: api.port,
    rejectUnauthorized: false,
    // A name for SNI, so a server with a public certificate sends the right one; never an IP.
    ...(isIP(api.host) ? {} : { servername: api.host }),
    ...(api.ca ? { ca: api.ca } : {}),
  });
  socket.setTimeout(30_000, () => socket.destroy(new Error("timed out")));
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("secureConnect", resolve);
      socket.once("error", reject);
    });
  } catch (err) {
    socket.destroy();
    throw new PluginError(`Can't reach ${api.name}: ${(err as Error).message}`);
  }
  const cert = socket.getPeerCertificate();
  const seen = cert.fingerprint256 ?? "";
  const pinned = normalizeFp(seen) === normalizeFp(api.fingerprint);
  const publicCa = socket.authorized && !checkServerIdentity(api.host, cert);
  if (!pinned && !publicCa) {
    socket.destroy();
    throw new PluginError(
      `${api.name}'s certificate doesn't match the pinned fingerprint. It now shows ${seen || "no certificate"}. If its certificate was renewed, put that in ${api.setting} and restart the brain; if not, something else may be answering in its place.`,
    );
  }
  let res: { code: number; status: string; text: string };
  try {
    res = await new Promise((resolve, reject) => {
      const req = request(
        {
          method,
          host: api.host,
          port: api.port,
          path: `/api2/json${path}`,
          headers: {
            authorization: api.auth,
            accept: "application/json",
            ...(form && {
              "content-type": "application/x-www-form-urlencoded",
              "content-length": Buffer.byteLength(body),
            }),
          },
          createConnection: () => socket,
        },
        (r) => {
          const chunks: Buffer[] = [];
          r.on("data", (c: Buffer) => chunks.push(c));
          r.on("error", reject);
          r.on("end", () =>
            resolve({
              code: r.statusCode ?? 0,
              status: r.statusMessage ?? "",
              text: Buffer.concat(chunks).toString(),
            }),
          );
        },
      );
      req.on("error", reject);
      req.end(body);
    });
  } catch (err) {
    throw new PluginError(`${api.name} request failed: ${(err as Error).message}`);
  } finally {
    socket.destroy();
  }
  if (res.code !== 200)
    throw new PluginError(`${api.name}: ${res.status || `HTTP ${res.code}`}`, res.code);
  return (JSON.parse(res.text || "{}") as { data: unknown }).data;
}

export class Proxmox {
  readonly hasApi: boolean;
  readonly configured: boolean;
  private api: PinnedApi;
  readonly node: string;
  readonly desktopId: string;
  readonly brainId: string;
  pollMs = 2000;

  constructor(env: Record<string, string | undefined> = process.env) {
    const url = env.PROXMOX_URL ? new URL(env.PROXMOX_URL) : null;
    this.api = {
      name: "Proxmox",
      host: url?.hostname ?? "",
      port: Number(url?.port || 8006),
      fingerprint: normalizeFp(env.PROXMOX_TLS_FINGERPRINT ?? ""),
      setting: "PROXMOX_TLS_FINGERPRINT in Settings → Proxmox",
      auth: `PVEAPIToken=${env.PROXMOX_TOKEN_ID}=${env.PROXMOX_TOKEN_SECRET}`,
    };
    this.node = env.PROXMOX_NODE ?? "";
    this.desktopId = env.HATBOT_DESKTOP_ID ?? "";
    this.brainId = env.HATBOT_BRAIN_ID ?? "";
    this.hasApi = Boolean(
      this.api.host &&
        this.node &&
        env.PROXMOX_TOKEN_ID &&
        env.PROXMOX_TOKEN_SECRET &&
        this.api.fingerprint,
    );
    this.configured = this.hasApi && /^\d+$/.test(this.desktopId);
  }

  get(path: string): Promise<unknown> {
    return this.request("GET", path);
  }

  post(path: string, form: Record<string, string> = {}): Promise<unknown> {
    return this.request("POST", path, form);
  }

  private request(method: "GET" | "POST", path: string, form?: Record<string, string>) {
    if (!this.hasApi) throw new PluginError("Proxmox isn't set up: see Settings → Proxmox.");
    return pinnedRequest(this.api, method, path, form);
  }

  private get lxc() {
    return `/nodes/${encodeURIComponent(this.node)}/lxc/${this.desktopId}`;
  }

  async desktopSnapshots(): Promise<Snapshot[]> {
    const list = (await this.request("GET", `${this.lxc}/snapshot`)) as {
      name: string;
      description?: string;
      snaptime?: number;
    }[];
    return list
      .filter((s) => s.name !== "current")
      .sort((a, b) => (b.snaptime ?? 0) - (a.snaptime ?? 0))
      .map((s) => ({
        name: s.name,
        description: s.description?.trim() ?? "",
        createdAt: s.snaptime ? new Date(s.snaptime * 1000).toISOString() : null,
      }));
  }

  async rollbackDesktop(name: string, timeoutMs = 180_000) {
    if (!/^[A-Za-z][\w-]{0,39}$/.test(name)) throw new PluginError("Not a snapshot name.", 400);
    if (!this.configured) throw new PluginError("The desktop's id isn't set.");
    const upid = (await this.request(
      "POST",
      `${this.lxc}/snapshot/${encodeURIComponent(name)}/rollback`,
      { start: "1" },
    )) as string;
    const exit = await this.waitTask(upid, timeoutMs);
    if (exit === null) throw new PluginError("The rollback is taking too long; check Proxmox.");
    if (exit !== "OK") throw new PluginError(`Rollback failed: ${exit}`);
  }

  /** The task's exit status ("OK" when it worked), or null on timeout. */
  async waitTask(upid: string, timeoutMs: number, signal?: AbortSignal): Promise<string | null> {
    const node = upid.split(":")[1] || this.node;
    const deadline = Date.now() + timeoutMs;
    // Quick at first: starting or rebooting a container often takes a second or two.
    for (let wait = 100; Date.now() < deadline; wait = Math.min(wait * 2, this.pollMs)) {
      await Bun.sleep(Math.min(wait, this.pollMs));
      signal?.throwIfAborted();
      const t = (await this.request(
        "GET",
        `/nodes/${encodeURIComponent(node)}/tasks/${encodeURIComponent(upid)}/status`,
      )) as { status: string; exitstatus?: string };
      if (t.status === "stopped") return t.exitstatus ?? "unknown";
    }
    return null;
  }
}
