// Reading what came in, and what a box's own user wrote, without being led elsewhere.
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";

/** A stream's bytes until it ends or passes `max`, and whether it did: what's past that is never read. */
export async function readStream(
  body: ReadableStream<Uint8Array> | null,
  max: number,
): Promise<{ bytes: Uint8Array; over: boolean }> {
  const reader = body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (reader && size <= max) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
  }
  if (size > max) await reader?.cancel().catch(() => {});
  return { bytes: Buffer.concat(chunks), over: size > max };
}

/** The body, or null once it's over `max` bytes: one that says it is isn't read at all. */
export async function readUpTo(req: Request, max: number): Promise<Uint8Array | null> {
  if (Number(req.headers.get("content-length") ?? 0) > max) return null;
  const { bytes, over } = await readStream(req.body, max);
  return over ? null : bytes;
}

/**
 * A file a build wrote, as text: null when it isn't there, isn't a plain file of its own (a link the
 * build made to /proc/self/environ, say, which the agent would read as itself) or is over `max` bytes.
 */
export function readWritten(path: string, max: number): string | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1 || st.size > max) return null;
    const buf = Buffer.alloc(st.size);
    let n = 0;
    while (n < st.size) {
      const got = readSync(fd, buf, n, st.size - n, n);
      if (!got) break;
      n += got;
    }
    return buf.subarray(0, n).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/** Long output keeps its start and end, where errors and results usually are. */
export function clip(out: string, max = 30_000): string {
  if (out.length <= max) return out;
  const half = Math.floor(max / 2);
  return `${out.slice(0, half)}\n… ${out.length - max} characters left out …\n${out.slice(-half)}`;
}
