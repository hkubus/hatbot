// Proxmox VE API client with Hatbot's scoped token (PLAN.md §9.3): the desktop's snapshots for
// Settings, and the Proxmox plugin's calls.
// The host's certificate is self-signed, so the connection is pinned to its SHA-256 fingerprint. A
// certificate from a public CA for the host's name is accepted too, so one that renews itself (ACME)
// keeps working. Bun's fetch skips checkServerIdentity when rejectUnauthorized is off, so this speaks
// HTTP/1.1 over a node:tls socket it has checked itself.
import { isIP } from "node:net";
import { checkServerIdentity, connect } from "node:tls";
import { PluginError } from "./plugins/plugin";

/** Its message is fine to show the owner and the model. */
export class ProxmoxError extends PluginError {
  constructor(
    message: string,
    readonly status = 0,
  ) {
    super(message);
  }
}

export type Snapshot = { name: string; description: string; createdAt: string | null };

const normalizeFp = (fp: string) => fp.replace(/:/g, "").toUpperCase();

function decodeChunked(body: Buffer): Buffer {
  const out: Buffer[] = [];
  let i = 0;
  while (i < body.length) {
    const eol = body.indexOf("\r\n", i);
    if (eol < 0) break;
    const size = Number.parseInt(body.subarray(i, eol).toString(), 16);
    if (!size) break;
    out.push(body.subarray(eol + 2, eol + 2 + size));
    i = eol + 2 + size + 2;
  }
  return Buffer.concat(out);
}

/** A Proxmox-style API (VE or Backup Server) behind a self-signed certificate. */
export type PinnedApi = {
  /** For messages: "Proxmox", "Proxmox Backup Server". */
  name: string;
  host: string;
  port: number;
  /** SHA-256, colons optional. */
  fingerprint: string;
  /** Where the owner sets the fingerprint, for when the certificate changes. */
  setting: string;
  /** The Authorization header. */
  auth: string;
  /** Certificate authorities to trust instead of the system's: for tests. */
  ca?: string;
};

/** One call to /api2/json over a connection checked against the pinned fingerprint; its `data`. */
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
    throw new ProxmoxError(`Can't reach ${api.name}: ${(err as Error).message}`);
  }
  const cert = socket.getPeerCertificate();
  const seen = cert.fingerprint256 ?? "";
  const pinned = normalizeFp(seen) === normalizeFp(api.fingerprint);
  const publicCa = socket.authorized && !checkServerIdentity(api.host, cert);
  if (!pinned && !publicCa) {
    socket.destroy();
    throw new ProxmoxError(
      `${api.name}'s certificate doesn't match the pinned fingerprint. It now shows ${seen || "no certificate"}. If its certificate was renewed, put that in ${api.setting} and restart the brain; if not, something else may be answering in its place.`,
    );
  }
  const chunks: Buffer[] = [];
  const done = new Promise<void>((resolve, reject) => {
    socket.on("data", (c: Buffer) => chunks.push(c));
    socket.once("end", resolve);
    socket.once("close", () => resolve());
    socket.once("error", reject);
  });
  socket.write(
    [
      `${method} /api2/json${path} HTTP/1.1`,
      `Host: ${api.host}:${api.port}`,
      `Authorization: ${api.auth}`,
      "Accept: application/json",
      "Connection: close",
      ...(form
        ? [
            "Content-Type: application/x-www-form-urlencoded",
            `Content-Length: ${Buffer.byteLength(body)}`,
          ]
        : []),
      "",
      body,
    ].join("\r\n"),
  );
  try {
    await done;
  } catch (err) {
    throw new ProxmoxError(`${api.name} request failed: ${(err as Error).message}`);
  } finally {
    socket.destroy();
  }

  const raw = Buffer.concat(chunks);
  const split = raw.indexOf("\r\n\r\n");
  if (split < 0) throw new ProxmoxError(`${api.name} sent a malformed response.`);
  const head = raw.subarray(0, split).toString();
  let payload: Buffer = raw.subarray(split + 4);
  if (/^transfer-encoding:\s*chunked/im.test(head)) payload = decodeChunked(payload);
  const status = /^HTTP\/1\.[01] (\d{3}) ?(.*)$/m.exec(head);
  const code = Number(status?.[1] ?? 0);
  if (code !== 200) throw new ProxmoxError(`${api.name}: ${status?.[2] || `HTTP ${code}`}`, code);
  return (JSON.parse(payload.toString() || "{}") as { data: unknown }).data;
}

export class Proxmox {
  /** The API's address, token and fingerprint are set. */
  readonly hasApi: boolean;
  /** …and the desktop's id, for its snapshots. */
  readonly configured: boolean;
  private host: string;
  private port: number;
  readonly node: string;
  private auth: string;
  private fingerprint: string;
  readonly desktopId: string;
  readonly brainId: string;
  /** The longest waitTask goes between asking Proxmox whether a task is done. */
  pollMs = 2000;

  constructor(env: Record<string, string | undefined> = process.env) {
    const url = env.PROXMOX_URL ? new URL(env.PROXMOX_URL) : null;
    this.host = url?.hostname ?? "";
    this.port = Number(url?.port || 8006);
    this.node = env.PROXMOX_NODE ?? "";
    this.auth = `PVEAPIToken=${env.PROXMOX_TOKEN_ID}=${env.PROXMOX_TOKEN_SECRET}`;
    this.fingerprint = normalizeFp(env.PROXMOX_TLS_FINGERPRINT ?? "");
    this.desktopId = env.HATBOT_DESKTOP_ID ?? "";
    this.brainId = env.HATBOT_BRAIN_ID ?? "";
    this.hasApi = Boolean(
      this.host &&
        this.node &&
        env.PROXMOX_TOKEN_ID &&
        env.PROXMOX_TOKEN_SECRET &&
        this.fingerprint,
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
    if (!this.hasApi) throw new ProxmoxError("Proxmox isn't set up (no /etc/hatbot/proxmox.env).");
    return pinnedRequest(
      {
        name: "Proxmox",
        host: this.host,
        port: this.port,
        fingerprint: this.fingerprint,
        setting: "PROXMOX_TLS_FINGERPRINT in /etc/hatbot/proxmox.env",
        auth: this.auth,
      },
      method,
      path,
      form,
    );
  }

  private get lxc() {
    return `/nodes/${encodeURIComponent(this.node)}/lxc/${this.desktopId}`;
  }

  /** The desktop's snapshots, newest first. */
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

  /** Rolls the desktop back to a snapshot and starts it again; resolves when Proxmox is done. */
  async rollbackDesktop(name: string, timeoutMs = 180_000) {
    if (!/^[A-Za-z][\w-]{0,39}$/.test(name)) throw new ProxmoxError("Not a snapshot name.", 400);
    if (!this.configured) throw new ProxmoxError("The desktop's id isn't set.");
    const upid = (await this.request(
      "POST",
      `${this.lxc}/snapshot/${encodeURIComponent(name)}/rollback`,
      { start: "1" },
    )) as string;
    const exit = await this.waitTask(upid, timeoutMs);
    if (exit === null) throw new ProxmoxError("The rollback is taking too long; check Proxmox.");
    if (exit !== "OK") throw new ProxmoxError(`Rollback failed: ${exit}`);
  }

  /** Waits for a Proxmox task to end: its exit status ("OK" when it worked), or null on timeout. */
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
