// Minecraft's own protocols: Server List Ping on the game port, which needs no password, and RCON.
import { connect, type Socket } from "node:net";
import { PluginError } from "@hatbot/plugin-sdk";

export type Address = { host: string; port: number };
type Options = { timeoutMs?: number; signal?: AbortSignal };

/** A refused RCON password, apart from a server that can't be reached. */
export const REFUSED = 401;
/** Vanilla reads a packet in one read of 1460 bytes, its 14 bytes of framing included. */
export const MAX_COMMAND_BYTES = 1446;
const MAX_PACKET = 1 << 20;
const MAX_STATUS = 1 << 21;

/** One TCP connection, read as the protocol needs it, given up on after its time. */
class Conn {
  private data: Buffer = Buffer.alloc(0);
  private connected = false;
  private failed: PluginError | null = null;
  private wake: (() => void) | null = null;
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly stop = () => this.fail("Stopped.");
  timedOut = false;

  constructor(
    private readonly socket: Socket,
    readonly where: string,
    timeoutMs: number,
    private readonly signal?: AbortSignal,
  ) {
    socket.setNoDelay(true);
    socket.on("connect", () => {
      this.connected = true;
      this.poke();
    });
    socket.on("data", (d: Buffer) => {
      this.data = this.data.length ? Buffer.concat([this.data, d]) : d;
      this.poke();
    });
    socket.on("error", (err: NodeJS.ErrnoException) => this.fail(this.reason(err)));
    socket.on("close", () => this.fail(`${where} closed the connection.`));
    this.timer = setTimeout(() => {
      this.timedOut = true;
      this.fail(`${where} didn't answer within ${Math.round(timeoutMs / 1000)} seconds.`);
    }, timeoutMs);
    signal?.addEventListener("abort", this.stop, { once: true });
  }

  static async open({ host, port }: Address, o: Options = {}) {
    const c = new Conn(connect({ host, port }), `${host}:${port}`, o.timeoutMs ?? 10_000, o.signal);
    try {
      await c.until(() => c.connected || undefined);
    } catch (err) {
      c.close();
      throw err;
    }
    return c;
  }

  private reason(err: NodeJS.ErrnoException) {
    const host = this.where.slice(0, this.where.lastIndexOf(":"));
    switch (err.code) {
      case "ECONNREFUSED":
        return `Nothing answers on ${this.where}.`;
      case "ENOTFOUND":
      case "EAI_AGAIN":
        return `Can't find ${host}.`;
      case "EHOSTUNREACH":
      case "ENETUNREACH":
        return `Can't reach ${host}.`;
      case "ECONNRESET":
      case "EPIPE":
        return `${this.where} closed the connection.`;
      default:
        return `Can't reach ${this.where}: ${err.message}`;
    }
  }

  private fail(why: string) {
    this.failed ??= new PluginError(why);
    this.socket.destroy();
    this.poke();
  }

  private poke() {
    const w = this.wake;
    this.wake = null;
    w?.();
  }

  private async until<T>(get: () => T | undefined): Promise<T> {
    for (;;) {
      const v = get();
      if (v !== undefined) return v;
      if (this.failed) throw this.failed;
      await new Promise<void>((r) => {
        this.wake = r;
      });
    }
  }

  async read(n: number): Promise<Buffer> {
    const got = await this.until(() =>
      this.data.length >= n ? this.data.subarray(0, n) : undefined,
    );
    this.data = this.data.subarray(n);
    return got;
  }

  write(bytes: Uint8Array) {
    this.socket.write(bytes);
  }

  close() {
    clearTimeout(this.timer);
    this.signal?.removeEventListener("abort", this.stop);
    this.failed ??= new PluginError("Closed.");
    this.socket.destroy();
  }
}

const LOGIN = 3;
const COMMAND = 2;
const AUTH_RESPONSE = 2;

function packet(id: number, type: number, body: Uint8Array) {
  const out = Buffer.alloc(14 + body.length);
  out.writeInt32LE(10 + body.length, 0);
  out.writeInt32LE(id, 4);
  out.writeInt32LE(type, 8);
  out.set(body, 12);
  return out;
}

async function readPacket(c: Conn) {
  const length = (await c.read(4)).readInt32LE(0);
  if (length < 10 || length > MAX_PACKET) throw new PluginError(`${c.where} doesn't speak RCON.`);
  const rest = await c.read(length);
  return { id: rest.readInt32LE(0), type: rest.readInt32LE(4), body: rest.subarray(8, length - 2) };
}

/**
 * Logs in and runs one command; its answer, put together from every packet it came in. A server
 * splits a long answer without marking its end, so after the first part an empty packet follows,
 * which it answers only once the command's parts are out. Not sooner: vanilla drops a connection
 * whose read holds more than one packet.
 */
export async function rcon(
  at: Address,
  password: string,
  command: string,
  o: Options = {},
): Promise<string> {
  const c = await Conn.open(at, o);
  const parts: Buffer[] = [];
  try {
    c.write(packet(1, LOGIN, Buffer.from(password)));
    for (;;) {
      const p = await readPacket(c);
      if (p.type !== AUTH_RESPONSE) continue;
      if (p.id === -1) throw new PluginError(`${c.where} refused the RCON password.`, REFUSED);
      if (p.id === 1) break;
    }
    c.write(packet(2, COMMAND, Buffer.from(command)));
    for (;;) {
      const p = await readPacket(c);
      if (p.id === 3) break;
      if (p.id === -1) throw new PluginError(`${c.where} refused the RCON password.`, REFUSED);
      if (p.id !== 2) continue;
      if (!parts.length) c.write(packet(3, 0, new Uint8Array()));
      parts.push(p.body);
    }
  } catch (err) {
    // A server that never answers the empty packet still gave its answer.
    if (!(parts.length && c.timedOut)) throw err;
  } finally {
    c.close();
  }
  return Buffer.concat(parts).toString("utf8");
}

const varint = (n: number) => {
  const out: number[] = [];
  let v = n >>> 0;
  do {
    out.push((v & 0x7f) | (v > 0x7f ? 0x80 : 0));
    v >>>= 7;
  } while (v);
  return Buffer.from(out);
};

async function readVarint(c: Conn) {
  let n = 0;
  for (let i = 0; i < 5; i++) {
    const b = (await c.read(1))[0] ?? 0;
    n |= (b & 0x7f) << (7 * i);
    if (!(b & 0x80)) return n;
  }
  throw new PluginError(`${c.where} doesn't speak Minecraft's protocol.`);
}

function varintAt(buf: Buffer, at: number): [value: number, next: number] {
  let n = 0;
  for (let i = 0; i < 5 && at + i < buf.length; i++) {
    const b = buf[at + i] ?? 0;
    n |= (b & 0x7f) << (7 * i);
    if (!(b & 0x80)) return [n, at + i + 1];
  }
  return [-1, buf.length];
}

export type Status = {
  version: string;
  motd: string;
  online: number;
  max: number;
  /** Some of the players on: a server names up to 12, picked at random. */
  sample: string[];
};

/** Formatting codes (§a, §l…), which servers put in names and the MOTD. */
export const plain = (s: string) => s.replace(/§./gs, "");

/** A chat component's text: a string, or {text, extra}, or a list of them. */
const textOf = (c: unknown): string => {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map(textOf).join("");
  if (!c || typeof c !== "object") return "";
  const { text, extra } = c as { text?: unknown; extra?: unknown };
  return textOf(text ?? "") + textOf(extra ?? []);
};

export function statusFrom(json: unknown): Status {
  const s = (json && typeof json === "object" ? json : {}) as {
    version?: { name?: unknown };
    players?: { online?: unknown; max?: unknown; sample?: unknown };
    description?: unknown;
  };
  const sample = Array.isArray(s.players?.sample) ? s.players.sample : [];
  return {
    version: plain(String(s.version?.name ?? "")).trim(),
    motd: plain(textOf(s.description))
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .join(" / "),
    online: Number(s.players?.online) || 0,
    max: Number(s.players?.max) || 0,
    sample: sample
      .map((p: { name?: unknown }) => plain(String(p?.name ?? "")).trim())
      .filter(Boolean),
  };
}

/** Server List Ping, as the game's server list does it: a handshake, then a status request. */
export async function ping(at: Address, o: Options = {}): Promise<Status> {
  const c = await Conn.open(at, { timeoutMs: 5000, ...o });
  try {
    const host = Buffer.from(at.host);
    const port = Buffer.alloc(2);
    port.writeUInt16BE(at.port);
    // Protocol -1: the version isn't known yet, as a client asking for it says.
    const handshake = Buffer.concat([
      varint(0),
      varint(-1),
      varint(host.length),
      host,
      port,
      varint(1),
    ]);
    c.write(Buffer.concat([varint(handshake.length), handshake, varint(1), varint(0)]));
    const length = await readVarint(c);
    if (length < 1 || length > MAX_STATUS)
      throw new PluginError(`${c.where} doesn't speak Minecraft's protocol.`);
    const body = await c.read(length);
    const [id, at1] = varintAt(body, 0);
    const [size, at2] = varintAt(body, at1);
    if (id !== 0 || size < 0 || at2 + size > body.length)
      throw new PluginError(`${c.where} doesn't speak Minecraft's protocol.`);
    try {
      return statusFrom(JSON.parse(body.subarray(at2, at2 + size).toString("utf8")));
    } catch {
      throw new PluginError(`${c.where} sent a status that isn't JSON.`);
    }
  } finally {
    c.close();
  }
}
