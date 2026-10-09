// Proxmox VE API client, scoped to Hatbot's own guests (PLAN.md §7.2).
// The host's certificate is self-signed, so the connection is pinned to its SHA-256 fingerprint.
// Bun's fetch skips checkServerIdentity when rejectUnauthorized is off, so this speaks HTTP/1.1
// over a node:tls socket it has checked itself.
import { connect } from "node:tls";

export class ProxmoxError extends Error {
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

export class Proxmox {
  readonly configured: boolean;
  private host: string;
  private port: number;
  private node: string;
  private auth: string;
  private fingerprint: string;
  readonly desktopId: string;
  /** How often rollbackDesktop asks Proxmox whether it's done. */
  pollMs = 2000;

  constructor(env: Record<string, string | undefined> = process.env) {
    const url = env.PROXMOX_URL ? new URL(env.PROXMOX_URL) : null;
    this.host = url?.hostname ?? "";
    this.port = Number(url?.port || 8006);
    this.node = env.PROXMOX_NODE ?? "";
    this.auth = `PVEAPIToken=${env.PROXMOX_TOKEN_ID}=${env.PROXMOX_TOKEN_SECRET}`;
    this.fingerprint = normalizeFp(env.PROXMOX_TLS_FINGERPRINT ?? "");
    this.desktopId = env.HATBOT_DESKTOP_ID ?? "";
    this.configured = Boolean(
      this.host &&
        this.node &&
        env.PROXMOX_TOKEN_ID &&
        env.PROXMOX_TOKEN_SECRET &&
        this.fingerprint &&
        /^\d+$/.test(this.desktopId),
    );
  }

  private async request(method: "GET" | "POST", path: string, form?: Record<string, string>) {
    if (!this.configured)
      throw new ProxmoxError("Proxmox isn't set up (no /etc/hatbot/proxmox.env).");
    const body = form ? new URLSearchParams(form).toString() : "";
    const socket = connect({ host: this.host, port: this.port, rejectUnauthorized: false });
    socket.setTimeout(30_000, () => socket.destroy(new Error("timed out")));
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("secureConnect", resolve);
        socket.once("error", reject);
      });
    } catch (err) {
      socket.destroy();
      throw new ProxmoxError(`Can't reach Proxmox: ${(err as Error).message}`);
    }
    if (normalizeFp(socket.getPeerCertificate().fingerprint256 ?? "") !== this.fingerprint) {
      socket.destroy();
      throw new ProxmoxError("Proxmox's certificate doesn't match the pinned fingerprint.");
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
        `Host: ${this.host}:${this.port}`,
        `Authorization: ${this.auth}`,
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
      throw new ProxmoxError(`Proxmox request failed: ${(err as Error).message}`);
    } finally {
      socket.destroy();
    }

    const raw = Buffer.concat(chunks);
    const split = raw.indexOf("\r\n\r\n");
    if (split < 0) throw new ProxmoxError("Proxmox sent a malformed response.");
    const head = raw.subarray(0, split).toString();
    let payload: Buffer = raw.subarray(split + 4);
    if (/^transfer-encoding:\s*chunked/im.test(head)) payload = decodeChunked(payload);
    const status = /^HTTP\/1\.[01] (\d{3}) ?(.*)$/m.exec(head);
    const code = Number(status?.[1] ?? 0);
    if (code !== 200) throw new ProxmoxError(`Proxmox: ${status?.[2] || `HTTP ${code}`}`, code);
    return (JSON.parse(payload.toString() || "{}") as { data: unknown }).data;
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
    const upid = (await this.request(
      "POST",
      `${this.lxc}/snapshot/${encodeURIComponent(name)}/rollback`,
      { start: "1" },
    )) as string;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await Bun.sleep(this.pollMs);
      const t = (await this.request(
        "GET",
        `/nodes/${encodeURIComponent(this.node)}/tasks/${encodeURIComponent(upid)}/status`,
      )) as { status: string; exitstatus?: string };
      if (t.status === "stopped") {
        if (t.exitstatus !== "OK") throw new ProxmoxError(`Rollback failed: ${t.exitstatus}`);
        return;
      }
    }
    throw new ProxmoxError("The rollback is taking too long; check Proxmox.");
  }
}
