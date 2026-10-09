import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import type { AppEnv } from "../context";
import type { Principal } from "./service";

export const SESSION_COOKIE = "hatbot_session";

export function principalOf(c: Context<AppEnv>): Principal | null {
  const { auth } = c.var;
  const header = c.req.header("authorization");
  if (header?.startsWith("Bearer ")) return auth.resolveToken(header.slice(7).trim());
  const cookie = getCookie(c, SESSION_COOKIE);
  return cookie ? auth.resolveSession(cookie) : null;
}

/** Requires a session cookie or a bearer token. Cookie-authenticated writes must come from the public origin. */
export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const principal = principalOf(c);
  if (!principal) return c.json({ error: "unauthorized" }, 401);
  if (principal.kind === "session" && !["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
    if (c.req.header("origin") !== c.var.config.publicUrl)
      return c.json({ error: "bad origin" }, 403);
  }
  c.set("principal", principal);
  await next();
};
