import { PluginError } from "@hatbot/plugin-sdk";
import { API_PREFIX, type Health } from "@hatbot/shared";
import { type Context, Hono, type Next } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getConnInfo } from "hono/bun";
import { HTTPException } from "hono/http-exception";
import { principalOf, requireAuth } from "./auth/middleware";
import type { AuthService } from "./auth/service";
import { compressJson } from "./compress";
import type { AppEnv, Deps } from "./context";
import { UserError } from "./errors";
import { adminRoutes } from "./routes/admin";
import { authRoutes } from "./routes/auth";
import { botRoutes } from "./routes/bots";
import { checkRoutes } from "./routes/checks";
import { desktopRoutes } from "./routes/desktop";
import { memoryRoutes } from "./routes/memory";
import { negotiationRoutes } from "./routes/negotiations";
import { pluginRoutes } from "./routes/plugins";
import { proposalRoutes } from "./routes/proposals";
import { questionRoutes } from "./routes/questions";
import { searchRoutes } from "./routes/search";
import { streamRoutes } from "./routes/stream";
import { approvalRoutes, taskRoutes } from "./routes/tasks";
import { threadRoutes } from "./routes/thread";
import { todoRoutes } from "./routes/todo";

export const VERSION = "0.1.0";

export function createApp(deps: Deps) {
  const app = new Hono<AppEnv>().basePath(API_PREFIX);

  app.use(compressJson);
  app.use(async (c, next) => {
    for (const [k, v] of Object.entries(deps)) c.set(k as keyof Deps, v as never);
    c.set("clientIp", clientIp(c, deps.config.trustedProxies, deps.auth));
    await next();
  });
  // Bun takes bodies up to the 25 MB an attachment needs. Sign-in and the notification buttons answer
  // strangers, so they read 16 KB at most; everything else 5 MB, which a memory file fits in.
  const small = bodyLimit({
    maxSize: 16 * 1024,
    onError: (c) => c.json({ error: TOO_LARGE }, 413),
  });
  app.use("/auth/*", small);
  app.use("/approvals/:id/token-decision", small);
  app.use("/pause-all/token", small);
  app.use("/questions/:id/token-answer", small);
  app.use(async (c, next) => {
    if (c.req.method === "POST" && c.req.path === `${API_PREFIX}/attachments`) return next();
    // hatbox.fetch carries up to 5 MB, as base64 in JSON.
    if (/^\/api\/v1\/boxes\/\d+\/call$/.test(c.req.path))
      return limitBody(c, next, 7.5 * 1024 * 1024);
    return limitBody(c, next, 5 * 1024 * 1024);
  });

  app.get("/health", (c) => c.json<Health>({ ok: true, version: VERSION }));
  app.route("/", authRoutes);
  app.route("/", threadRoutes);
  app.route("/", botRoutes);
  app.route("/", memoryRoutes);
  app.route("/", adminRoutes);
  app.route("/", streamRoutes);
  app.route("/", taskRoutes);
  app.route("/", approvalRoutes);
  app.route("/", desktopRoutes);
  app.route("/", pluginRoutes);
  app.route("/", questionRoutes);
  app.route("/", checkRoutes);
  app.route("/", negotiationRoutes);
  app.route("/", searchRoutes);
  app.route("/", proposalRoutes);
  app.route("/", todoRoutes);
  for (const { id, routes, publicRoutes, sockets } of deps.plugins.routed()) {
    for (const path of publicRoutes) app.all(path, toPlugin(id));
    for (const path of sockets) app.get(path, socketAuth, toPlugin(id));
    for (const path of routes) app.on(ALL, [path, `${path}/*`], requireAuth, toPlugin(id));
  }

  app.notFound((c) => c.json({ error: "That's gone." }, 404));
  app.onError((err, c) => {
    // Hono's own refusals, such as malformed JSON, keep their status, in the usual shape.
    // A body cut off part way reads as malformed JSON to the validator.
    if (overflowed.has(c.req.raw)) return c.json({ error: TOO_LARGE }, 413);
    if (err instanceof HTTPException)
      return (
        err.res ??
        c.json({ error: err.message || "Something in that request isn't right." }, err.status)
      );
    if (err instanceof UserError) return c.json({ error: err.message }, err.status);
    // A plugin's own refusal, such as bad settings, is shown as it is. Its status is the service's.
    if (err instanceof PluginError) return c.json({ error: err.message }, 400);
    console.error(err);
    return c.json({ error: "Something went wrong." }, 500);
  });
  return app;
}

const ALL = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

/** A switched-off plugin's paths are gone, as if it weren't installed. */
const toPlugin = (id: string) => async (c: Context<AppEnv>) => {
  const routes = c.var.plugins.routesOf(id);
  if (!routes) return c.json({ error: "That's gone." }, 404);
  const principal = c.var.principal ?? null;
  return routes.fetch(c.req.raw, {
    principal,
    clientIp: c.var.clientIp,
    server: c.env,
    onSignOut: (fn: () => void) => (principal ? c.var.auth.onEnd(principal, fn) : () => {}),
  });
};

/** As /stream: a cookie needs the public Origin, an app uses its bearer token. */
const socketAuth = async (c: Context<AppEnv>, next: Next) => {
  const principal = principalOf(c, { renew: false });
  if (!principal) return c.json({ error: "You're not signed in." }, 401);
  const { publicUrl } = c.var.config;
  if (principal.kind === "session" && c.req.header("origin") !== publicUrl)
    return c.json({ error: `Open Hatbot at ${publicUrl} to make changes.` }, 403);
  c.set("principal", principal);
  await next();
};

const TOO_LARGE = "That's too large.";
const overflowed = new WeakSet<Request>();

/** Nothing is read ahead, so a route that checks who you are first still does so before any of it. */
function limitBody(c: Context, next: Next, max: number): Response | Promise<void> {
  const raw = c.req.raw;
  if (!raw.body) return next();
  const length = raw.headers.get("content-length");
  if (length !== null && !raw.headers.has("transfer-encoding"))
    return Number(length) > max ? c.json({ error: TOO_LARGE }, 413) : next();
  let size = 0;
  let req: Request;
  const counted = raw.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, out) {
        size += chunk.byteLength;
        if (size <= max) return out.enqueue(chunk);
        overflowed.add(req);
        out.error(new HTTPException(413, { message: TOO_LARGE }));
      },
    }),
  );
  req = new Request(raw, { body: counted, duplex: "half" } as RequestInit);
  c.req.raw = req;
  return next();
}

// The socket peer, or the client your reverse proxy reports if the peer is the proxy.
function clientIp(
  c: Parameters<typeof getConnInfo>[0],
  trusted: string[],
  auth: Pick<AuthService, "forwardedBy">,
): string {
  let peer = "unknown";
  try {
    peer = getConnInfo(c).remote.address ?? "unknown";
  } catch {
    // app.request() in tests has no socket.
  }
  peer = peer.replace(/^::ffff:/, "");
  const forwarded = c.req.header("x-forwarded-for")?.split(",").at(-1)?.trim();
  if (trusted.includes(peer)) {
    if (forwarded) return forwarded;
  } else if (forwarded && isPrivate(peer)) {
    // Your proxy, not listed: every sign-in would count as coming from it, and lock out the rest.
    auth.forwardedBy(peer);
  }
  return peer;
}

/** Loopback, private and link-local addresses: where a reverse proxy on your network would be. */
function isPrivate(ip: string): boolean {
  return (
    /^(127|10)\./.test(ip) ||
    /^192\.168\./.test(ip) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ||
    /^169\.254\./.test(ip) ||
    /^(::1$|f[cd][0-9a-f]{2}:|fe[89ab][0-9a-f]:)/i.test(ip)
  );
}
