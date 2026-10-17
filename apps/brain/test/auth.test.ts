import { describe, expect, test } from "bun:test";
import type { Session, SignedOutOthers } from "@hatbot/shared";
import { FailureLimiter } from "../src/auth/service";
import { resetLogin } from "../src/reset-login";
import { ORIGIN, setUpOwner, testApp } from "./helpers";

const cookieOf = (res: Response, name: string) =>
  res.headers
    .getSetCookie()
    .find((c) => c.startsWith(`${name}=`))
    ?.split(";")[0];

describe("setup", () => {
  test("needs the setup code and a valid first TOTP code", async () => {
    const t = await testApp();
    expect(await (await t.call("GET", "/auth/me")).json()).toEqual({
      setupDone: false,
      authenticated: false,
    });
    expect((await t.call("POST", "/auth/setup/start", { code: "wrong" })).status).toBe(403);

    const { secret } = (await (
      await t.call("POST", "/auth/setup/start", { code: t.auth.setupCode })
    ).json()) as {
      secret: string;
    };
    const bad = await t.call("POST", "/auth/setup", {
      code: t.auth.setupCode,
      password: "correct horse battery",
      totp: "000000",
    });
    expect(bad.status).toBe(403);
    const ok = await t.call("POST", "/auth/setup", {
      code: t.auth.setupCode,
      password: "correct horse battery",
      totp: t.code(secret),
    });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("set-cookie")).toContain("HttpOnly");
    expect((await t.call("POST", "/auth/setup/start", { code: t.auth.setupCode })).status).toBe(
      403,
    );
  });

  test("rejects short passwords", async () => {
    const t = await testApp();
    await t.call("POST", "/auth/setup/start", { code: t.auth.setupCode });
    const res = await t.call("POST", "/auth/setup", {
      code: t.auth.setupCode,
      password: "short",
      totp: "123456",
    });
    expect(res.status).toBe(400);
  });
});

describe("login", () => {
  test("web login sets a session cookie that authenticates", async () => {
    const t = await testApp();
    const { secret, password } = await setUpOwner(t);
    const res = await t.call("POST", "/auth/login", { password, totp: t.code(secret) });
    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie")?.split(";")[0] ?? "";
    expect(res.headers.get("set-cookie")).toContain("Secure");
    expect(res.headers.get("set-cookie")).toContain("SameSite=Strict");
    const me = await t.call("GET", "/auth/me", undefined, { cookie });
    expect(await me.json()).toEqual({ setupDone: true, authenticated: true });
  });

  test("a TOTP code works only once", async () => {
    const t = await testApp();
    const { secret, password } = await setUpOwner(t);
    const totp = t.code(secret);
    expect((await t.call("POST", "/auth/login", { password, totp })).status).toBe(200);
    expect((await t.call("POST", "/auth/login", { password, totp })).status).toBe(401);
  });

  test("wrong password fails, and says so plainly", async () => {
    const t = await testApp();
    const { secret } = await setUpOwner(t);
    const res = await t.call("POST", "/auth/login", { password: "nope", totp: t.code(secret) });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "That password or code isn't right." });
  });

  test("bodies that aren't a login count as failed attempts", async () => {
    const t = await testApp();
    const { secret, password } = await setUpOwner(t);
    for (const body of [{}, { password: "x" }, { password: "x", totp: "12" }, "not json"]) {
      const res = await t.app.request("/api/v1/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body: typeof body === "string" ? body : JSON.stringify(body),
      });
      expect(res.status).toBe(400);
    }
    for (let i = 0; i < 6; i++) await t.call("POST", "/auth/login", { password: "x" });
    const res = await t.call("POST", "/auth/login", { password, totp: t.code(secret) });
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "Too many tries. Try again in 15 minutes." });
  });

  test("sign-in and the notification buttons read 16 KB at most", async () => {
    const t = await testApp();
    const big = "x".repeat(17 * 1024);
    const login = await t.call("POST", "/auth/login", { password: big, totp: "123456" });
    expect(login.status).toBe(413);
    expect(await login.json()).toEqual({ error: "That's too large." });
    expect((await t.call("POST", "/auth/setup/start", { code: big })).status).toBe(413);
    const button = await t.call("POST", "/approvals/1/token-decision", {
      decision: "approve",
      exp: 1,
      sig: big,
    });
    expect(button.status).toBe(413);
    // A chunked body, with no length to go by, is cut off too.
    const chunked = await t.app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: new Blob([JSON.stringify({ password: big, totp: "123456" })]).stream(),
    });
    expect(chunked.status).toBe(413);
  });

  test("signed-in requests read 5 MB at most, apart from file uploads", async () => {
    const t = await testApp();
    const { cookie } = await setUpOwner(t);
    const huge = "x".repeat(5 * 1024 * 1024 + 1);
    const res = await t.call("PUT", "/memory/file?path=notes.md", { content: huge }, { cookie });
    expect(res.status).toBe(413);
    const form = new FormData();
    form.append("file", new File([huge], "big.txt", { type: "text/plain" }));
    const upload = await t.app.request("/api/v1/attachments", {
      method: "POST",
      headers: { cookie, origin: ORIGIN },
      body: form,
    });
    expect(upload.status).toBe(201);
    // In chunks: refused once 5 MB has come, and a stranger's isn't read at all.
    let pulled = 0;
    const chunks = () =>
      new ReadableStream<Uint8Array>({
        pull(ctl) {
          pulled++;
          if (pulled > 200) ctl.close();
          else ctl.enqueue(new Uint8Array(64 * 1024).fill(120));
        },
      });
    const chunked = await t.app.request("/api/v1/memory/file?path=notes.md", {
      method: "PUT",
      headers: { "content-type": "application/json", cookie, origin: ORIGIN },
      body: chunks(),
    });
    expect(chunked.status).toBe(413);
    expect(pulled).toBeLessThan(100);
    pulled = 0;
    const stranger = await t.app.request("/api/v1/memory/file?path=notes.md", {
      method: "PUT",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: chunks(),
    });
    expect(stranger.status).toBe(401);
    expect(pulled).toBeLessThan(5);
  });

  test("locks out after 10 failures", async () => {
    const t = await testApp();
    const { secret, password } = await setUpOwner(t);
    for (let i = 0; i < 10; i++)
      await t.call("POST", "/auth/login", { password: "nope", totp: "000000" });
    expect((await t.call("POST", "/auth/login", { password, totp: t.code(secret) })).status).toBe(
      429,
    );
    t.advance(16 * 60_000);
    expect((await t.call("POST", "/auth/login", { password, totp: t.code(secret) })).status).toBe(
      200,
    );
  });

  test("a burst of attempts at once is held to the limit, not let through while the first is checked", async () => {
    const t = await testApp();
    const { secret, password } = await setUpOwner(t);
    const statuses = await Promise.all(
      Array.from(
        { length: 30 },
        async () =>
          (await t.call("POST", "/auth/login", { password: "nope", totp: "000000" })).status,
      ),
    );
    expect(statuses.filter((s) => s === 401)).toHaveLength(10);
    expect(statuses.filter((s) => s === 429)).toHaveLength(20);
    expect((await t.call("POST", "/auth/login", { password, totp: t.code(secret) })).status).toBe(
      429,
    );
  });

  test("a right attempt is taken back off the overall count", async () => {
    const t = await testApp();
    const { secret, password } = await setUpOwner(t);
    for (let i = 0; i < 3; i++)
      await t.call("POST", "/auth/login", { password: "nope", totp: "000000" });
    expect((await t.call("POST", "/auth/login", { password, totp: t.code(secret) })).status).toBe(
      200,
    );
    for (let i = 0; i < 46; i++) t.loginLimits.global.fail("*");
    expect(t.loginLimits.global.blocked("*")).toBe(false);
    t.loginLimits.global.fail("*");
    expect(t.loginLimits.global.blocked("*")).toBe(true);
  });

  test("a browser that signed in before still can while strangers are locked out", async () => {
    const t = await testApp();
    const { secret, password } = await setUpOwner(t);
    const first = await t.call("POST", "/auth/login", { password, totp: t.code(secret) });
    const device = cookieOf(first, "hatbot_device") ?? "";
    expect(device).toStartWith("hatbot_device=");
    expect(first.headers.getSetCookie().join("\n")).toContain("Path=/api/v1/auth");
    // Strangers fail from everywhere: their own address and the whole brain are blocked.
    for (let i = 0; i < 10; i++)
      await t.call("POST", "/auth/login", { password: "nope", totp: "000000" });
    for (let i = 0; i < 50; i++) t.loginLimits.global.fail("*");
    t.advance(30_000);
    const stranger = await t.call("POST", "/auth/login", { password, totp: t.code(secret) });
    expect(stranger.status).toBe(429);
    const forged = await t.call(
      "POST",
      "/auth/login",
      { password, totp: t.code(secret) },
      { cookie: "hatbot_device=made.up" },
    );
    expect(forged.status).toBe(429);
    const known = await t.call(
      "POST",
      "/auth/login",
      { password, totp: t.code(secret) },
      { cookie: device },
    );
    expect(known.status).toBe(200);
    // The known browser isn't given a new mark, and has a limit of its own.
    expect(cookieOf(known, "hatbot_device")).toBeUndefined();
    for (let i = 0; i < 10; i++)
      await t.call("POST", "/auth/login", { password: "nope", totp: "000000" }, { cookie: device });
    t.advance(30_000);
    const after = await t.call(
      "POST",
      "/auth/login",
      { password, totp: t.code(secret) },
      { cookie: device },
    );
    expect(after.status).toBe(429);
  });

  test("the overall limit says once when it trips", () => {
    const tripped: string[] = [];
    const limit = new FailureLimiter(
      3,
      60_000,
      () => 0,
      (key) => tripped.push(key),
    );
    limit.fail("*");
    limit.fail("*");
    expect(tripped).toEqual([]);
    limit.fail("*");
    expect(limit.blocked("*")).toBe(true);
    expect(tripped).toEqual(["*"]);
    limit.fail("*");
    expect(tripped).toEqual(["*"]);
  });

  test("a proxy that isn't trusted is noticed, and Check everything says to add it", async () => {
    const t = await testApp();
    const { cookie } = await setUpOwner(t);
    const via = (address: string) => ({
      requestIP: () => ({ address, family: "IPv4", port: 40000 }),
    });
    await t.app.request(
      "/api/v1/health",
      { headers: { "x-forwarded-for": "5.6.7.8" } },
      via("8.8.4.4"),
    );
    expect(t.auth.untrustedProxy).toBeNull();
    await t.app.request("/api/v1/health", {}, via("192.168.1.10"));
    expect(t.auth.untrustedProxy).toBeNull();
    await t.app.request(
      "/api/v1/health",
      { headers: { "x-forwarded-for": "5.6.7.8" } },
      via("192.168.1.10"),
    );
    expect(t.auth.untrustedProxy).toBe("192.168.1.10");
    const report = (await (await t.call("POST", "/checks", undefined, { cookie })).json()) as {
      results: { id: string; state: string; detail: string }[];
    };
    const check = report.results.find((r) => r.id === "public-url");
    expect(check?.state).toBe("warn");
    expect(check?.detail).toContain("192.168.1.10, which isn't in HATBOT_TRUSTED_PROXIES");
  });

  test("app login returns a bearer token", async () => {
    const t = await testApp();
    const { secret, password } = await setUpOwner(t);
    const res = await t.call("POST", "/auth/login", {
      password,
      totp: t.code(secret),
      client: "app",
      device: "iPhone",
    });
    const { token } = (await res.json()) as { token: string };
    expect(token).toStartWith("hbt_");
    const tokens = await t.call("GET", "/tokens", undefined, { authorization: `Bearer ${token}` });
    expect(((await tokens.json()) as { name: string }[]).map((x) => x.name)).toEqual(["iPhone"]);
  });

  test("logout ends the session", async () => {
    const t = await testApp();
    const { cookie } = await setUpOwner(t);
    expect((await t.call("POST", "/auth/logout", {}, { cookie })).status).toBe(200);
    expect((await t.call("GET", "/tokens", undefined, { cookie })).status).toBe(401);
  });

  test("logout with a bearer token ends the token", async () => {
    const t = await testApp();
    const { secret, password } = await setUpOwner(t);
    const res = await t.call("POST", "/auth/login", {
      password,
      totp: t.code(secret),
      client: "app",
      device: "iPhone",
    });
    const { token } = (await res.json()) as { token: string };
    const bearer = { authorization: `Bearer ${token}` };
    expect((await t.call("POST", "/auth/logout", {}, bearer)).status).toBe(200);
    expect((await t.call("GET", "/tokens", undefined, bearer)).status).toBe(401);
  });

  test("sessions expire after 30 days without use", async () => {
    const t = await testApp();
    const { cookie } = await setUpOwner(t);
    t.advance(31 * 86400_000);
    expect((await t.call("GET", "/tokens", undefined, { cookie })).status).toBe(401);
  });

  test("a session in use sends its cookie again as its expiry moves on", async () => {
    const t = await testApp();
    const { cookie } = await setUpOwner(t);
    // Within the day, nothing moves.
    expect((await t.call("GET", "/tokens", undefined, { cookie })).headers.get("set-cookie")).toBe(
      null,
    );
    for (let day = 0; day < 3; day++) {
      t.advance(20 * 86400_000);
      const res = await t.call("GET", "/tokens", undefined, { cookie });
      expect(res.status).toBe(200);
      const renewed = res.headers.get("set-cookie") ?? "";
      expect(renewed).toStartWith(`${cookie};`);
      expect(renewed).toContain("Max-Age=2592000");
    }
    // /auth/me renews it too, which the web app asks first.
    t.advance(20 * 86400_000);
    const me = await t.call("GET", "/auth/me", undefined, { cookie });
    expect(me.headers.get("set-cookie")).toStartWith(`${cookie};`);
  });

  test("expired sessions are pruned", async () => {
    const t = await testApp();
    await setUpOwner(t);
    const count = () =>
      t.db.query<{ n: number }, []>("SELECT count(*) AS n FROM sessions").get()?.n;
    expect(count()).toBe(1);
    t.advance(31 * 86400_000);
    t.auth.createSession(null);
    expect(count()).toBe(1);
    t.advance(31 * 86400_000);
    t.auth.prune();
    expect(count()).toBe(0);
  });
});

describe("your account", () => {
  async function signedInTwice() {
    const t = await testApp();
    const { secret, password, cookie } = await setUpOwner(t);
    const other = await t.call("POST", "/auth/login", { password, totp: t.code(secret) });
    const otherCookie = other.headers.get("set-cookie")?.split(";")[0] ?? "";
    t.advance(30_000);
    const app = await t.call("POST", "/auth/login", {
      password,
      totp: t.code(secret),
      client: "app",
      device: "iPhone",
    });
    const { token } = (await app.json()) as { token: string };
    t.advance(30_000);
    const works = async (headers: Record<string, string>) =>
      (await t.call("GET", "/tokens", undefined, headers)).status === 200;
    return { t, secret, password, cookie, otherCookie, token, works };
  }

  test("changing the password needs the old one and a code, and signs out everywhere else", async () => {
    const { t, secret, password, cookie, otherCookie, token, works } = await signedInTwice();
    const wrong = await t.call(
      "POST",
      "/auth/password",
      { password: "not it", totp: t.code(secret), newPassword: "a whole new password" },
      { cookie },
    );
    expect(wrong.status).toBe(401);
    const short = await t.call(
      "POST",
      "/auth/password",
      { password, totp: t.code(secret), newPassword: "short" },
      { cookie },
    );
    expect(short.status).toBe(400);
    const res = await t.call(
      "POST",
      "/auth/password",
      { password, totp: t.code(secret), newPassword: "a whole new password" },
      { cookie },
    );
    expect(res.status).toBe(200);
    expect((await res.json()) as SignedOutOthers).toEqual({ ok: true, ended: 2 });
    expect(await works({ cookie })).toBe(true);
    expect(await works({ cookie: otherCookie })).toBe(false);
    expect(await works({ authorization: `Bearer ${token}` })).toBe(false);
    t.advance(30_000);
    expect((await t.call("POST", "/auth/login", { password, totp: t.code(secret) })).status).toBe(
      401,
    );
    t.advance(30_000);
    const fresh = await t.call("POST", "/auth/login", {
      password: "a whole new password",
      totp: t.code(secret),
    });
    expect(fresh.status).toBe(200);
  });

  test("a password change from another site is refused", async () => {
    const { t, secret, password, cookie } = await signedInTwice();
    const res = await t.call(
      "POST",
      "/auth/password",
      { password, totp: t.code(secret), newPassword: "a whole new password" },
      { cookie, origin: "https://evil.test" },
    );
    expect(res.status).toBe(403);
  });

  test("a new authenticator takes over once a code from it comes back", async () => {
    const { t, secret, password, cookie, otherCookie, token, works } = await signedInTwice();
    expect(
      (await t.call("POST", "/auth/totp/start", { password, totp: "000000" }, { cookie })).status,
    ).toBe(401);
    const start = await t.call(
      "POST",
      "/auth/totp/start",
      { password, totp: t.code(secret) },
      { cookie },
    );
    expect(start.status).toBe(200);
    const next = (await start.json()) as { secret: string; uri: string };
    expect(next.uri).toContain(`secret=${next.secret}`);
    // Nothing has changed yet: the old authenticator still works, and the new one isn't asked for.
    expect((await t.call("POST", "/auth/totp", { totp: t.code(secret) }, { cookie })).status).toBe(
      403,
    );
    // Only the browser that asked can finish it.
    expect(
      (await t.call("POST", "/auth/totp", { totp: t.code(next.secret) }, { cookie: otherCookie }))
        .status,
    ).toBe(403);
    const done = await t.call("POST", "/auth/totp", { totp: t.code(next.secret) }, { cookie });
    expect(done.status).toBe(200);
    expect((await done.json()) as SignedOutOthers).toEqual({ ok: true, ended: 2 });
    expect(await works({ cookie })).toBe(true);
    expect(await works({ authorization: `Bearer ${token}` })).toBe(false);
    t.advance(30_000);
    expect((await t.call("POST", "/auth/login", { password, totp: t.code(secret) })).status).toBe(
      401,
    );
    t.advance(30_000);
    expect(
      (await t.call("POST", "/auth/login", { password, totp: t.code(next.secret) })).status,
    ).toBe(200);
  });

  test("a new authenticator not confirmed in 10 minutes is dropped", async () => {
    const { t, secret, password, cookie } = await signedInTwice();
    const start = await t.call(
      "POST",
      "/auth/totp/start",
      { password, totp: t.code(secret) },
      { cookie },
    );
    const next = (await start.json()) as { secret: string };
    t.advance(11 * 60_000);
    expect(
      (await t.call("POST", "/auth/totp", { totp: t.code(next.secret) }, { cookie })).status,
    ).toBe(403);
  });

  test("you see where you're signed in, and can sign out one or everywhere else", async () => {
    const { t, cookie, otherCookie, token, works } = await signedInTwice();
    const list = (await (
      await t.call("GET", "/auth/sessions", undefined, { cookie })
    ).json()) as Session[];
    expect(list).toHaveLength(2);
    expect(list.filter((s) => s.current)).toHaveLength(1);
    const other = list.find((s) => !s.current);
    expect(
      (await t.call("DELETE", `/auth/sessions/${other?.id}`, undefined, { cookie })).status,
    ).toBe(200);
    expect(await works({ cookie: otherCookie })).toBe(false);
    expect(await works({ authorization: `Bearer ${token}` })).toBe(true);
    const all = await t.call("POST", "/auth/sign-out-others", {}, { cookie });
    expect((await all.json()) as SignedOutOthers).toEqual({ ok: true, ended: 1 });
    expect(await works({ authorization: `Bearer ${token}` })).toBe(false);
    expect(await works({ cookie })).toBe(true);
  });

  test("the reset forgets the password and authenticator and signs out everything", async () => {
    const { t, cookie, token, works } = await signedInTwice();
    resetLogin(t.db);
    expect(t.auth.isSetUp()).toBe(false);
    expect(await works({ cookie })).toBe(false);
    expect(await works({ authorization: `Bearer ${token}` })).toBe(false);
    const start = await t.call("POST", "/auth/setup/start", { code: t.auth.setupCode });
    expect(start.status).toBe(200);
  });
});

describe("tokens", () => {
  test("create, use, revoke", async () => {
    const t = await testApp();
    const { cookie } = await setUpOwner(t);
    const created = (await (
      await t.call("POST", "/tokens", { name: "cli" }, { cookie })
    ).json()) as {
      id: number;
      token: string;
    };
    const bearer = { authorization: `Bearer ${created.token}` };
    expect((await t.call("GET", "/tokens", undefined, bearer)).status).toBe(200);
    expect((await t.call("DELETE", `/tokens/${created.id}`, undefined, { cookie })).status).toBe(
      200,
    );
    expect((await t.call("GET", "/tokens", undefined, bearer)).status).toBe(401);
  });

  test("cookie writes from another origin are refused", async () => {
    const t = await testApp();
    const { cookie } = await setUpOwner(t);
    const res = await t.call(
      "POST",
      "/tokens",
      { name: "x" },
      { cookie, origin: "https://evil.test" },
    );
    expect(res.status).toBe(403);
  });

  test("needs auth", async () => {
    const t = await testApp();
    expect((await t.call("GET", "/tokens")).status).toBe(401);
  });
});
