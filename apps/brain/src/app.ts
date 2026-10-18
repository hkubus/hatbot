import { API_PREFIX, type Health } from "@hatbot/shared";
import { type Context, Hono, type Next } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getConnInfo } from "hono/bun";
import { HTTPException } from "hono/http-exception";
import type { AuthService } from "./auth/service";
import { compressJson } from "./compress";
import type { AppEnv, Deps } from "./context";
import { UserError } from "./errors";
import { PluginError } from "./plugins/plugin";
import { adminRoutes } from "./routes/admin";
import { authRoutes } from "./routes/auth";
import { botRoutes } from "./routes/bots";
import { boxRoutes } from "./routes/boxes";
import { checkRoutes } from "./routes/checks";
import { desktopRoutes } from "./routes/desktop";
import { heartbeatRoutes } from "./routes/heartbeat";
import { memoryRoutes } from "./routes/memory";
import { negotiationRoutes } from "./routes/negotiations";
import { pluginRoutes } from "./routes/plugins";
import { proposalRoutes } from "./routes/proposals";
import { questionRoutes } from "./routes/questions";
import { hookRoutes, scheduleRoutes } from "./routes/schedules";
import { searchRoutes } from "./routes/search";
import { streamRoutes } from "./routes/stream";
import { approvalRoutes, taskRoutes } from "./routes/tasks";
import { teachRoutes } from "./routes/teach";
import { threadRoutes } from "./routes/thread";
import { todoRoutes } from "./routes/todo";
import { watcherRoutes } from "./routes/watchers";

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
  app.route("/", scheduleRoutes);
  app.route("/", hookRoutes);
  app.route("/", pluginRoutes);
  app.route("/", questionRoutes);
  app.route("/", teachRoutes);
  app.route("/", checkRoutes);
  app.route("/", negotiationRoutes);
  app.route("/", watcherRoutes);
  app.route("/", searchRoutes);
  app.route("/", heartbeatRoutes);
  app.route("/", proposalRoutes);
  app.route("/", todoRoutes);
  app.route("/", boxRoutes);

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

const TOO_LARGE = "That's too large.";
/** Requests whose body was cut off by limitBody. */
const overflowed = new WeakSet<Request>();

/**
 * Refuses a body over `max` bytes: at once by its length, or, sent in chunks, once that much has come.
 * Nothing is read ahead, so a route that checks who you are first still does so before any of it.
 */
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
