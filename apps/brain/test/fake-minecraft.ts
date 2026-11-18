// Stand-ins for a Minecraft server on loopback: its game port, which answers Server List Ping, and
// RCON, which behaves as vanilla's does.
import { afterAll } from "bun:test";

const varint = (n: number) => {
  const out: number[] = [];
  let v = n >>> 0;
  do {
    out.push((v & 0x7f) | (v > 0x7f ? 0x80 : 0));
    v >>>= 7;
  } while (v);
  return Buffer.from(out);
};

function varintAt(buf: Buffer, at: number): [number, number] | null {
  let n = 0;
  for (let i = 0; i < 5; i++) {
    if (at + i >= buf.length) return null;
    const b = buf[at + i] ?? 0;
    n |= (b & 0x7f) << (7 * i);
    if (!(b & 0x80)) return [n | 0, at + i + 1];
  }
  return null;
}

/** Answers a handshake and status request with `status()`, and keeps the handshakes. */
export function fakeGame(status: () => unknown) {
  const handshakes: { protocol: number; host: string; port: number; next: number }[] = [];
  const server = Bun.listen<{ buf: Buffer }>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(s) {
        s.data = { buf: Buffer.alloc(0) };
      },
      data(s, chunk) {
        s.data.buf = Buffer.concat([s.data.buf, Buffer.from(chunk)]);
        const packets: Buffer[] = [];
        let at = 0;
        for (;;) {
          const len = varintAt(s.data.buf, at);
          if (!len || len[1] + len[0] > s.data.buf.length) break;
          packets.push(s.data.buf.subarray(len[1], len[1] + len[0]));
          at = len[1] + len[0];
        }
        const [hs, request] = packets;
        if (!hs || !request) return;
        const [, a] = varintAt(hs, 0) ?? [0, 0];
        const [protocol, b] = varintAt(hs, a) ?? [0, 0];
        const [hostLength, c] = varintAt(hs, b) ?? [0, 0];
        const host = hs.subarray(c, c + hostLength).toString();
        const port = hs.readUInt16BE(c + hostLength);
        const [next] = varintAt(hs, c + hostLength + 2) ?? [0];
        handshakes.push({ protocol, host, port, next });
        const json = Buffer.from(JSON.stringify(status()));
        const body = Buffer.concat([varint(0), varint(json.length), json]);
        s.write(Buffer.concat([varint(body.length), body]));
      },
    },
  });
  afterAll(() => server.stop(true));
  return { port: server.port, handshakes };
}

const packet = (id: number, type: number, body: Uint8Array) => {
  const out = Buffer.alloc(14 + body.length);
  out.writeInt32LE(10 + body.length, 0);
  out.writeInt32LE(id, 4);
  out.writeInt32LE(type, 8);
  out.set(body, 12);
  return out;
};

/**
 * RCON as vanilla runs it: a read must hold one whole packet or the connection drops, a refused
 * login answers id -1, an answer goes out in parts of 4096 bytes, and a packet of another type gets
 * "Unknown request". `answer` gives what a command prints.
 */
export function fakeRcon(password: string, answer: (command: string) => string) {
  const commands: string[] = [];
  const server = Bun.listen<{ authed: boolean }>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(s) {
        s.data = { authed: false };
      },
      data(s, chunk) {
        const buf = Buffer.from(chunk);
        if (buf.length < 14 || buf.readInt32LE(0) !== buf.length - 4) {
          s.end();
          return;
        }
        const id = buf.readInt32LE(4);
        const type = buf.readInt32LE(8);
        const body = buf.subarray(12, buf.length - 2).toString();
        if (type === 3) {
          s.data.authed = body === password;
          s.write(packet(s.data.authed ? id : -1, 2, new Uint8Array()));
        } else if (type === 2) {
          if (!s.data.authed) {
            s.write(packet(-1, 2, new Uint8Array()));
            return;
          }
          commands.push(body);
          const out = Buffer.from(answer(body));
          let at = 0;
          do {
            s.write(packet(id, 0, out.subarray(at, at + 4096)));
            at += 4096;
          } while (at < out.length);
        } else s.write(packet(id, 0, Buffer.from(`Unknown request ${type.toString(16)}`)));
      },
    },
  });
  afterAll(() => server.stop(true));
  return { port: server.port, commands };
}

/** A port nothing listens on. */
export function closedPort() {
  const s = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = s.port;
  s.stop(true);
  return port;
}
