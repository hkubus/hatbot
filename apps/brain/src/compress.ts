import { promisify } from "node:util";
import { brotliCompress, constants, gzip } from "node:zlib";
import type { MiddlewareHandler } from "hono";

export type Encoding = "br" | "gzip";

const brotli = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

/** Smaller than this fits in a packet or two either way. */
const MIN_BYTES = 1024;

export function pickEncoding(header: string | null | undefined): Encoding | null {
  if (!header) return null;
  const weights = new Map<string, number>();
  for (const part of header.toLowerCase().split(",")) {
    const [name = "", ...params] = part.split(";").map((s) => s.trim());
    const q = params.find((p) => p.startsWith("q="));
    weights.set(name, q ? Number(q.slice(2)) || 0 : 1);
  }
  const any = weights.get("*") ?? 0;
  for (const enc of ["br", "gzip"] as const) if ((weights.get(enc) ?? any) > 0) return enc;
  return null;
}

/**
 * Off the event loop: Bun's zlib runs on its thread pool. Brotli at 5 is about 50 MB/s here and
 * within a few per cent of its best on chat text.
 */
export const compressJson: MiddlewareHandler = async (c, next) => {
  await next();
  const res = c.res;
  if (
    c.req.method === "HEAD" ||
    !res.body ||
    res.headers.has("content-encoding") ||
    !res.headers.get("content-type")?.startsWith("application/json")
  )
    return;
  c.header("vary", "accept-encoding", { append: true });
  const encoding = pickEncoding(c.req.header("accept-encoding"));
  if (!encoding) return;
  const raw = await c.res.bytes();
  if (raw.length < MIN_BYTES) {
    c.res = new Response(raw, c.res);
    return;
  }
  const body =
    encoding === "br"
      ? await brotli(raw, {
          params: {
            [constants.BROTLI_PARAM_QUALITY]: 5,
            [constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
          },
        })
      : await gzipAsync(raw, { level: 6 });
  c.res = new Response(body, c.res);
  c.res.headers.delete("content-length");
  c.res.headers.set("content-encoding", encoding);
};
