import type { Context, MiddlewareHandler } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { AppEnv } from "../context";
import { type Principal, SESSION_DAYS } from "./service";

export const SESSION_COOKIE = "hatbot_session";

export function setSessionCookie(c: Context<AppEnv>, token: string) {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: c.var.config.publicUrl.startsWith("https://"),
    sameSite: "Strict",
    path: "/",
    maxAge: SESSION_DAYS * 86400,
  });
}

/**
 * `renew: false` leaves a session's expiry where it is: a WebSocket upgrade answers with its own 101
 * and can't carry the cookie, so the next request moves both on.
 */
export function principalOf(c: Context<AppEnv>, opts: { renew?: boolean } = {}): Principal | null {
  const { auth } = c.var;
  const header = c.req.header("authorization");
  if (header?.startsWith("Bearer ")) return auth.resolveToken(header.slice(7).trim());
  const cookie = getCookie(c, SESSION_COOKIE);
  const session = cookie ? auth.resolveSession(cookie, opts.renew ?? true) : null;
  if (!session || !cookie) return null;
  // The session's expiry moved on, so the cookie's does too, or it would end on day 30 regardless.
  if (session.renewed) setSessionCookie(c, cookie);
  return { kind: session.kind, id: session.id };
}

/** Cookie-authenticated writes must come from the public origin. */
export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const principal = principalOf(c);
  if (!principal) return c.json({ error: "You're not signed in." }, 401);
  if (principal.kind === "session" && !["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
    const { publicUrl } = c.var.config;
    if (c.req.header("origin") !== publicUrl)
      return c.json({ error: `Open Hatbot at ${publicUrl} to make changes.` }, 403);
  }
  c.set("principal", principal);
  await next();
};
