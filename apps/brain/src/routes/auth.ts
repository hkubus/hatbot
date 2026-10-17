import { API_PREFIX, CreateToken, Login, type Me, SetupFinish, SetupStart } from "@hatbot/shared";
import type { Context } from "hono";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { principalOf, requireAuth, SESSION_COOKIE, setSessionCookie } from "../auth/middleware";
import type { AppEnv } from "../context";
import { badRequest, json } from "./util";

/** Marks a browser or app that has signed in here before (A18). Only sign-in routes see it. */
const DEVICE_COOKIE = "hatbot_device";

function rememberDevice(c: Context<AppEnv>) {
  if (c.var.auth.knownDevice(getCookie(c, DEVICE_COOKIE))) return;
  setCookie(c, DEVICE_COOKIE, c.var.auth.newDevice(), {
    httpOnly: true,
    secure: c.var.config.publicUrl.startsWith("https://"),
    sameSite: "Strict",
    path: `${API_PREFIX}/auth`,
    maxAge: 400 * 86400,
  });
}

const TOO_MANY = "Too many tries. Try again in 15 minutes.";

/**
 * Counts a sign-in attempt as failed before it's checked, so a burst can't all get past the limit while
 * the first is still being checked; ok() takes it back. Null when too many have failed. A browser that
 * has signed in here before counts on its own, so strangers' failures can't lock it out.
 */
function attempt(c: Context<AppEnv>): { ok(): void } | null {
  const { auth, loginLimits, clientIp } = c.var;
  const device = auth.knownDevice(getCookie(c, DEVICE_COOKIE));
  const key = device ? `device ${device}` : clientIp;
  if (loginLimits.perIp.blocked(key) || (!device && loginLimits.global.blocked("*"))) return null;
  loginLimits.perIp.fail(key);
  if (!device) loginLimits.global.fail("*");
  return {
    ok() {
      loginLimits.perIp.reset(key);
      if (!device) loginLimits.global.forgive("*");
    },
  };
}

export const authRoutes = new Hono<AppEnv>()
  .get("/auth/me", (c) =>
    c.json<Me>({ setupDone: c.var.auth.isSetUp(), authenticated: principalOf(c) !== null }),
  )

  // First run: the setup code from the log unlocks a TOTP secret, then password + first code finish it.
  .post("/auth/setup/start", json(SetupStart), (c) => {
    const res = c.var.auth.startSetup(c.req.valid("json").code);
    return res ? c.json(res) : c.json({ error: "That setup code isn't right." }, 403);
  })
  .post("/auth/setup", json(SetupFinish), async (c) => {
    const { code, password, totp } = c.req.valid("json");
    if (!(await c.var.auth.finishSetup(code, password, totp))) {
      return c.json({ error: "That code didn't match. Try the next one." }, 403);
    }
    setSessionCookie(c, c.var.auth.createSession(c.req.header("user-agent") ?? null));
    rememberDevice(c);
    return c.json({ ok: true });
  })

  .post("/auth/login", async (c) => {
    const { auth } = c.var;
    const tried = attempt(c);
    if (!tried) return c.json({ error: TOO_MANY }, 429);
    // A body that isn't a login counts as a failure too.
    const body = Login.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return badRequest(c, body.error);
    const { password, totp, client, device } = body.data;
    if (!(await auth.checkCredentials(password, totp))) {
      return c.json({ error: "That password or code isn't right." }, 401);
    }
    tried.ok();
    if (client === "app") {
      const { token } = auth.createToken(device ?? "App");
      rememberDevice(c);
      return c.json({ ok: true, token });
    }
    setSessionCookie(c, auth.createSession(c.req.header("user-agent") ?? null));
    rememberDevice(c);
    return c.json({ ok: true });
  })

  .post("/auth/logout", requireAuth, (c) => {
    // An app signs out with its bearer token, which ends that token.
    const principal = c.var.principal;
    if (principal.kind === "token") c.var.auth.deleteToken(principal.id);
    const cookie = getCookie(c, SESSION_COOKIE);
    if (cookie) c.var.auth.deleteSession(cookie);
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true });
  })

  .get("/tokens", requireAuth, (c) => c.json(c.var.auth.listTokens()))
  .post("/tokens", requireAuth, json(CreateToken), (c) =>
    c.json(c.var.auth.createToken(c.req.valid("json").name), 201),
  )
  .delete("/tokens/:id{[0-9]+}", requireAuth, (c) =>
    c.var.auth.deleteToken(Number(c.req.param("id")))
      ? c.json({ ok: true })
      : c.json({ error: "not found" }, 404),
  );
