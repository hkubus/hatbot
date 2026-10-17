// Serves the built web app (apps/web/dist) on the same origin as the API.
import { existsSync, type Stats, statSync } from "node:fs";
import { join, normalize, sep } from "node:path";
import { pickEncoding } from "./compress";

const HEADERS = {
  "content-security-policy":
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

/** What the build compressed beside each file (apps/web/vite.config.ts). */
const SUFFIX = { br: ".br", gzip: ".gz" } as const;

export function webHandler(dir: string): (req: Request) => Response {
  const root = normalize(dir) + sep;
  const index = join(root, "index.html");
  return (req) => {
    if (req.method !== "GET" && req.method !== "HEAD")
      return new Response("Method not allowed", { status: 405 });
    if (!existsSync(index)) {
      return new Response("The web app isn't built. Run: bun run --cwd apps/web build", {
        status: 503,
      });
    }
    const path = decodeURIComponent(new URL(req.url).pathname);
    const file = normalize(join(root, path));
    const stat = file.startsWith(root) ? statOf(file) : null;
    if (stat?.isFile()) {
      // Vite fingerprints everything under /assets.
      const cache = path.startsWith("/assets/")
        ? "public, max-age=31536000, immutable"
        : "no-cache";
      return send(req, file, stat, cache);
    }
    // A file that isn't there, such as an older build's chunk after an update, is a 404. The app in
    // its place would be run as that script, and kept by the service worker as it.
    if (path.startsWith("/assets/") || /\.[a-z0-9]+$/i.test(path)) {
      return new Response("Not found", {
        status: 404,
        headers: {
          ...HEADERS,
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store",
        },
      });
    }
    // Client-side routes fall back to the app.
    return send(req, index, statSync(index), "no-cache");
  };
}

function statOf(file: string): Stats | null {
  try {
    return statSync(file);
  } catch {
    return null;
  }
}

/** The file, compressed when the build left a fresh copy; a 304 when the browser has it already. */
function send(req: Request, file: string, stat: Stats, cache: string): Response {
  const etag = `W/"${stat.size.toString(36)}-${Math.trunc(stat.mtimeMs).toString(36)}"`;
  const headers: Record<string, string> = {
    ...HEADERS,
    "cache-control": cache,
    etag,
    vary: "accept-encoding",
  };
  const known = req.headers.get("if-none-match");
  if (known?.split(",").some((t) => t.trim() === etag))
    return new Response(null, { status: 304, headers });
  const encoding = pickEncoding(req.headers.get("accept-encoding"));
  const packed = encoding && statOf(file + SUFFIX[encoding]);
  // An older build's copy beside a newer file is stale.
  if (encoding && packed && packed.mtimeMs >= stat.mtimeMs) {
    headers["content-type"] = Bun.file(file).type;
    headers["content-encoding"] = encoding;
    return new Response(Bun.file(file + SUFFIX[encoding]), { headers });
  }
  return new Response(Bun.file(file), { headers });
}
