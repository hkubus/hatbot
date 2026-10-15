// Serves the built web app (apps/web/dist) on the same origin as the API.
import { existsSync, statSync } from "node:fs";
import { join, normalize, sep } from "node:path";

const HEADERS = {
  "content-security-policy":
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

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
    if (file.startsWith(root) && existsSync(file) && statSync(file).isFile()) {
      // Vite fingerprints everything under /assets.
      const cache = path.startsWith("/assets/")
        ? "public, max-age=31536000, immutable"
        : "no-cache";
      return new Response(Bun.file(file), { headers: { ...HEADERS, "cache-control": cache } });
    }
    // Client-side routes fall back to the app.
    return new Response(Bun.file(index), { headers: { ...HEADERS, "cache-control": "no-cache" } });
  };
}
