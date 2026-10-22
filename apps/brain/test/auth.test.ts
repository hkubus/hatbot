import { describe, expect, test } from "bun:test";
import type { Session, SignedOutOthers } from "@hatbot/shared";
import { AuthService, FailureLimiter } from "../src/auth/service";
import { resetLogin } from "../src/reset-login";
import { ORIGIN, setUpOwner, signIn, type TestApp, testApp, waitFor } from "./helpers";

const cookieOf = (res: Response, name: string) =>
  res.headers
    .getSetCookie()
    .find((c) => c.startsWith(`${name}=`))
    ?.split(";")[0];

/** The mark a sign-in gave its browser. */
const markOf = (res: Response) => cookieOf(res, "hatbot_device")?.split("=")[1];

const login = (t: TestApp, body: object, headers: Record<string, string> = {}) =>
  t.call("POST", "/auth/login", body, headers);

describe("sign-in", () => {
  test("setup needs the setup code and a first code, runs once, and the reset opens it again", async () => {
    const t = await testApp();
    expect((await t.call("POST", "/auth/setup/start", { code: "wrong" })).status).toBe(403);
    const start = await t.call("POST", "/auth/setup/start", { code: t.auth.setupCode });
    const { secret } = (await start.json()) as { secret: string };
    const setup = (password: string, totp: string) =>
      t.call("POST", "/auth/setup", { code: t.auth.setupCode, password, totp });
    expect((await setup("short", t.code(secret))).status).toBe(400);
    expect((await setup("correct horse battery", "000000")).status).toBe(403);
    const ok = await setup("correct horse battery", t.code(secret));
    expect(ok.status).toBe(200);
    const cookie = ok.headers.get("set-cookie")?.split(";")[0] ?? "";
    expect((await t.call("POST", "/auth/setup/start", { code: t.auth.setupCode })).status).toBe(
      403,
    );
    t.advance(30_000);
    const mark = markOf(
      await login(t, { password: "correct horse battery", totp: t.code(secret) }),
    );
    expect(t.auth.knownDevice(mark)).not.toBeNull();

    // The reset forgets the password and authenticator, signs out everything, and, once the brain
    // restarts, every browser.
    resetLogin(t.db);
    expect((await t.call("GET", "/tokens", undefined, { cookie })).status).toBe(401);
    expect(new AuthService(t.db).knownDevice(mark)).toBeNull();
    expect((await t.call("POST", "/auth/setup/start", { code: t.auth.setupCode })).status).toBe(
      200,
    );
  });

  test("a login gives the web a session cookie and the app a token, each good until signed out", async () => {
    const t = await testApp();
    const { secret, password } = await setUpOwner(t);
    const stranger = await t.call("GET", "/tokens");
    expect(stranger.status).toBe(401);
    expect(await stranger.json()).toEqual({ error: "You're not signed in." });
    const web = await login(t, { password, totp: t.code(secret) });
    const flags = web.headers.get("set-cookie") ?? "";
    for (const flag of ["HttpOnly", "Secure", "SameSite=Strict"]) expect(flags).toContain(flag);
    const cookie = flags.split(";")[0] ?? "";
    t.advance(30_000);
    const app = await login(t, { password, totp: t.code(secret), client: "app", device: "iPhone" });
    const { token } = (await app.json()) as { token: string };
    const bearer = { authorization: `Bearer ${token}` };
    const tokens = await t.call("GET", "/tokens", undefined, bearer);
    expect(((await tokens.json()) as { name: string }[]).map((x) => x.name)).toEqual(["iPhone"]);

    const made = (await (await t.call("POST", "/tokens", { name: "cli" }, { cookie })).json()) as {
      id: number;
      token: string;
    };
    const cli = { authorization: `Bearer ${made.token}` };
    expect((await t.call("GET", "/tokens", undefined, cli)).status).toBe(200);
    expect((await t.call("DELETE", `/tokens/${made.id}`, undefined, { cookie })).status).toBe(200);
    expect((await t.call("GET", "/tokens", undefined, cli)).status).toBe(401);
    const csrf = await t.call(
      "POST",
      "/tokens",
      { name: "x" },
      { cookie, origin: "https://evil.test" },
    );
    expect(csrf.status).toBe(403);
    expect(await csrf.json()).toEqual({ error: `Open Hatbot at ${ORIGIN} to make changes.` });

    // Signing out ends the session, and the browser drops its cached files; the app's, its token.
    const out = await t.call("POST", "/auth/logout", {}, { cookie });
    expect(out.headers.get("clear-site-data")).toBe('"cache"');
    expect((await t.call("GET", "/tokens", undefined, { cookie })).status).toBe(401);
    expect((await t.call("POST", "/auth/logout", {}, bearer)).status).toBe(200);
    expect((await t.call("GET", "/tokens", undefined, bearer)).status).toBe(401);
  });

  test("a code signs in once, even from two devices at the same moment", async () => {
    const t = await testApp();
    const { secret, password } = await setUpOwner(t);
    expect((await login(t, { password: "nope", totp: t.code(secret) })).status).toBe(401);
    const totp = t.code(secret);
    const [web, app] = await Promise.all([
      login(t, { password, totp }),
      login(t, { password, totp, client: "app", device: "iPhone" }),
    ]);
    expect([web.status, app.status].sort()).toEqual([200, 401]);
    expect((await login(t, { password, totp })).status).toBe(401);
  });

  test("ten failures from one address, malformed ones and a burst at once included, hold it for 15 minutes", async () => {
    const t = await testApp();
    const { secret, password } = await setUpOwner(t);
    for (const body of [JSON.stringify({ password: "x" }), "not json"]) {
      const res = await t.app.request("/api/v1/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body,
      });
      expect(res.status).toBe(400);
    }
    // Counted before they're checked, so a burst isn't let through while the first is checked.
    const statuses = await Promise.all(
      Array.from(
        { length: 20 },
        async () => (await login(t, { password: "nope", totp: "000000" })).status,
      ),
    );
    expect(statuses.filter((s) => s === 401)).toHaveLength(8);
    expect(statuses.filter((s) => s === 429)).toHaveLength(12);
    expect((await login(t, { password, totp: t.code(secret) })).status).toBe(429);
    t.advance(16 * 60_000);
    expect((await login(t, { password, totp: t.code(secret) })).status).toBe(200);

    // Behind a proxy that isn't trusted, every client is one address: noticed, and Check everything
    // says so when its own request came through it. One from before, which anyone on your network
    // can send, doesn't warn for good.
    const via = (address: string) => ({
      requestIP: () => ({ address, family: "IPv4", port: 40000 }),
    });
    const forwarded = { headers: { "x-forwarded-for": "5.6.7.8" } };
    await t.app.request("/api/v1/health", forwarded, via("8.8.4.4"));
    expect(t.auth.untrustedProxy).toBeNull();
    await t.app.request("/api/v1/health", forwarded, via("192.168.1.10"));
    expect(t.auth.untrustedProxy?.ip).toBe("192.168.1.10");
    const check = async () => (await t.checks.run()).results.find((r) => r.id === "public-url");
    // The clock stands still, so that request stands for the check's own.
    const now = await check();
    expect(now?.state).toBe("warn");
    expect(now?.detail).toContain("192.168.1.10");
    t.advance(1000);
    expect((await check())?.state).toBe("ok");
  });

  test("failures everywhere hold sign-in for all but known browsers; it's told for wrong tries, hourly", async () => {
    const t = await testApp();
    const { secret, password } = await setUpOwner(t);
    const first = await login(t, { password, totp: t.code(secret) });
    const device = cookieOf(first, "hatbot_device") ?? "";
    expect(first.headers.getSetCookie().join("\n")).toContain("Path=/api/v1/auth");
    const tripped: string[] = [];
    t.loginLimits.global = new FailureLimiter(50, 15 * 60_000, Date.now, (key) =>
      tripped.push(key),
    );
    for (let i = 0; i < 49; i++) t.loginLimits.global.fail("*");
    // A right sign-in at 49 is counted while it's checked, then taken back: it trips nothing.
    t.advance(30_000);
    expect((await login(t, { password, totp: t.code(secret) })).status).toBe(200);
    expect(tripped).toEqual([]);
    expect((await login(t, { password: "nope", totp: "000000" })).status).toBe(401);
    expect(tripped).toEqual(["*"]);

    t.advance(30_000);
    const right = () => ({ password, totp: t.code(secret) });
    expect((await login(t, right())).status).toBe(429);
    expect((await login(t, right(), { cookie: "hatbot_device=made.up" })).status).toBe(429);
    const known = await login(t, right(), { cookie: device });
    expect(known.status).toBe(200);
    expect(cookieOf(known, "hatbot_device")).toBeUndefined();
    // The known browser has a limit of its own.
    for (let i = 0; i < 10; i++)
      await login(t, { password: "nope", totp: "000000" }, { cookie: device });
    t.advance(30_000);
    expect((await login(t, right(), { cookie: device })).status).toBe(429);

    // Someone failing as fast as the window lets them keeps it tripped: told hourly, not each time.
    let now = 0;
    const told: string[] = [];
    const limit = new FailureLimiter(
      50,
      15 * 60_000,
      () => now,
      (key) => told.push(key),
    );
    for (; now < 2 * 3600_000 - 1000; now += 18_000) {
      if (limit.blocked("*")) continue;
      limit.fail("*");
      limit.stood("*");
    }
    expect(told).toEqual(["*", "*"]);
  });

  test("a body is read 16 KB at most before sign-in, 5 MB after with uploads apart, and a stranger's not at all", async () => {
    const t = await testApp();
    const { cookie } = signIn(t);
    let pulled = 0;
    const chunks = () => {
      pulled = 0;
      return new ReadableStream<Uint8Array>({
        pull(ctl) {
          if (++pulled > 200) ctl.close();
          else ctl.enqueue(new Uint8Array(64 * 1024).fill(120));
        },
      });
    };
    const send = (path: string, body: ReadableStream, headers: Record<string, string> = {}) =>
      t.app.request(`/api/v1${path}`, {
        method: path.startsWith("/auth") ? "POST" : "PUT",
        headers: { "content-type": "application/json", origin: ORIGIN, ...headers },
        body,
      });
    const big = "x".repeat(17 * 1024);
    expect((await login(t, { password: big, totp: "123456" })).status).toBe(413);
    // A chunked body, with no length to go by, is cut off too.
    expect((await send("/auth/login", chunks())).status).toBe(413);

    const huge = "x".repeat(5 * 1024 * 1024 + 1);
    const file = "/memory/file?path=notes.md";
    expect((await t.call("PUT", file, { content: huge }, { cookie })).status).toBe(413);
    expect((await send(file, chunks(), { cookie })).status).toBe(413);
    expect(pulled).toBeLessThan(100);
    expect((await send(file, chunks())).status).toBe(401);
    expect(pulled).toBeLessThan(5);
    const form = new FormData();
    form.append("file", new File([huge], "big.txt", { type: "text/plain" }));
    const upload = await t.app.request("/api/v1/attachments", {
      method: "POST",
      headers: { cookie, origin: ORIGIN },
      body: form,
    });
    expect(upload.status).toBe(201);
  });

  test("a session lasts 30 days from its last use, and its cookie moves on with it", async () => {
    const t = await testApp();
    const { cookie } = signIn(t);
    expect((await t.call("GET", "/tokens", undefined, { cookie })).headers.get("set-cookie")).toBe(
      null,
    );
    for (let i = 0; i < 2; i++) {
      t.advance(20 * 86400_000);
      const res = await t.call("GET", "/tokens", undefined, { cookie });
      expect(res.status).toBe(200);
      expect(res.headers.get("set-cookie")).toStartWith(`${cookie};`);
      expect(res.headers.get("set-cookie")).toContain("Max-Age=2592000");
    }
    // /auth/me renews it too, which the web app asks first.
    t.advance(20 * 86400_000);
    const me = await t.call("GET", "/auth/me", undefined, { cookie });
    expect(me.headers.get("set-cookie")).toStartWith(`${cookie};`);
    t.advance(31 * 86400_000);
    expect((await t.call("GET", "/tokens", undefined, { cookie })).status).toBe(401);
  });
});

describe("your account", () => {
  async function signedInTwice() {
    const t = await testApp();
    const { secret, password, cookie } = await setUpOwner(t);
    const other = await login(t, { password, totp: t.code(secret) });
    const otherCookie = other.headers.get("set-cookie")?.split(";")[0] ?? "";
    // The other browser is one sign-in knows, past the limit everyone else is held at.
    const otherMark = markOf(other);
    t.advance(30_000);
    const app = await login(t, { password, totp: t.code(secret), client: "app", device: "iPhone" });
    const { token } = (await app.json()) as { token: string };
    t.advance(30_000);
    const works = async (headers: Record<string, string>) =>
      (await t.call("GET", "/tokens", undefined, headers)).status === 200;
    const known = (mark: string | undefined) => t.auth.knownDevice(mark) !== null;
    expect(known(otherMark)).toBe(true);
    return { t, secret, password, cookie, otherCookie, otherMark, token, works, known };
  }

  test("changing the password needs the old one and a code, and signs out and forgets everywhere else", async () => {
    const { t, secret, password, cookie, otherCookie, otherMark, token, works, known } =
      await signedInTwice();
    const change = (body: object) =>
      t.call(
        "POST",
        "/auth/password",
        { password, totp: t.code(secret), newPassword: "a whole new password", ...body },
        { cookie },
      );
    expect((await change({ password: "not it" })).status).toBe(401);
    expect((await change({ newPassword: "short" })).status).toBe(400);
    const res = await change({});
    expect((await res.json()) as SignedOutOthers).toEqual({ ok: true, ended: 2 });
    expect(known(otherMark)).toBe(false);
    expect(known(markOf(res))).toBe(true);
    expect(await works({ cookie })).toBe(true);
    expect(await works({ cookie: otherCookie })).toBe(false);
    expect(await works({ authorization: `Bearer ${token}` })).toBe(false);
    t.advance(30_000);
    expect((await login(t, { password, totp: t.code(secret) })).status).toBe(401);
    t.advance(30_000);
    const fresh = await login(t, { password: "a whole new password", totp: t.code(secret) });
    expect(fresh.status).toBe(200);
  });

  test("a new authenticator takes over only once the browser that asked confirms it in time", async () => {
    const { t, secret, password, cookie, otherCookie, otherMark, token, works, known } =
      await signedInTwice();
    const start = async () => {
      t.advance(30_000);
      const res = await t.call(
        "POST",
        "/auth/totp/start",
        { password, totp: t.code(secret) },
        { cookie },
      );
      expect(res.status).toBe(200);
      return ((await res.json()) as { secret: string }).secret;
    };
    const confirm = async (totp: string, who = cookie) =>
      (await t.call("POST", "/auth/totp", { totp }, { cookie: who })).status;
    expect(
      (await t.call("POST", "/auth/totp/start", { password, totp: "000000" }, { cookie })).status,
    ).toBe(401);
    // Five wrong codes drop it, and so do ten minutes.
    let next = await start();
    const wrong = t.code(next) === "000000" ? "000001" : "000000";
    for (let i = 0; i < 5; i++) expect(await confirm(wrong)).toBe(403);
    expect(await confirm(t.code(next))).toBe(403);
    next = await start();
    t.advance(11 * 60_000);
    expect(await confirm(t.code(next))).toBe(403);

    // Nothing has changed yet: the old authenticator isn't the new one, and only the asker confirms.
    next = await start();
    expect(await confirm(t.code(secret))).toBe(403);
    expect(await confirm(t.code(next), otherCookie)).toBe(403);
    // A sign-in with the old authenticator's next code, still being checked as it changes, doesn't get in.
    t.advance(30_000);
    const ahead = t.code(secret);
    t.advance(-30_000);
    const verify = Bun.password.verify;
    let release = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    let checking = false;
    Bun.password.verify = async (...args: Parameters<typeof verify>) => {
      checking = true;
      await held;
      return verify(...args);
    };
    try {
      const intruder = login(t, { password, totp: ahead });
      await waitFor(() => checking);
      const done = await t.call("POST", "/auth/totp", { totp: t.code(next) }, { cookie });
      expect((await done.json()) as SignedOutOthers).toEqual({ ok: true, ended: 2 });
      release();
      expect((await intruder).status).toBe(401);
    } finally {
      Bun.password.verify = verify;
      release();
    }
    expect(known(otherMark)).toBe(false);
    expect(await works({ cookie })).toBe(true);
    expect(await works({ authorization: `Bearer ${token}` })).toBe(false);
    t.advance(30_000);
    expect((await login(t, { password, totp: t.code(secret) })).status).toBe(401);
    t.advance(30_000);
    expect((await login(t, { password, totp: t.code(next) })).status).toBe(200);
  });

  test("you see where you're signed in, and signing out the others stops them, mid-request too", async () => {
    const { t, secret, password, cookie, otherCookie, otherMark, token, works, known } =
      await signedInTwice();
    const sessions = async () =>
      (await (await t.call("GET", "/auth/sessions", undefined, { cookie })).json()) as Session[];
    const list = await sessions();
    expect(list).toHaveLength(2);
    expect(list.filter((s) => s.current)).toHaveLength(1);

    /** A request let in on its headers, whose body comes only when `finish` is called. */
    const slow = (path: string, headers: Record<string, string>, bytes: Uint8Array) => {
      let pulls = 0;
      let finish = () => {};
      const rest = new Promise<void>((r) => {
        finish = r;
      });
      const body = new ReadableStream<Uint8Array>(
        {
          async pull(ctl) {
            if (++pulls === 1) return ctl.enqueue(bytes.slice(0, 3));
            await rest;
            ctl.enqueue(bytes.slice(3));
            ctl.close();
          },
        },
        { highWaterMark: 0 },
      );
      const res = t.app.request(`/api/v1${path}`, {
        method: "POST",
        headers: { origin: ORIGIN, ...headers },
        body,
        duplex: "half",
      } as RequestInit);
      return { res, finish, reading: () => pulls > 1 };
    };
    const mint = slow(
      "/tokens",
      { authorization: `Bearer ${token}`, "content-type": "application/json" },
      new TextEncoder().encode('{"name":"Backup"}'),
    );
    const form = new FormData();
    form.append("file", new File(["hello"], "note.txt", { type: "text/plain" }));
    const multipart = new Request("http://x", { method: "POST", body: form });
    const upload = slow(
      "/attachments",
      { cookie: otherCookie, "content-type": multipart.headers.get("content-type") ?? "" },
      new Uint8Array(await multipart.arrayBuffer()),
    );
    await waitFor(() => mint.reading() && upload.reading());
    const all = await t.call("POST", "/auth/sign-out-others", {}, { cookie });
    expect((await all.json()) as SignedOutOthers).toEqual({ ok: true, ended: 2 });
    expect(known(otherMark)).toBe(false);
    expect(known(markOf(all))).toBe(true);
    mint.finish();
    upload.finish();
    expect((await mint.res).status).toBe(401);
    expect((await upload.res).status).toBe(401);
    expect(t.auth.listTokens()).toEqual([]);
    expect(await works({ cookie })).toBe(true);
    expect(await works({ cookie: otherCookie })).toBe(false);

    // One at a time; one already signed out, from another tab say, is gone.
    const again = await login(t, { password, totp: t.code(secret) });
    const againCookie = again.headers.get("set-cookie")?.split(";")[0] ?? "";
    const other = (await sessions()).find((s) => !s.current);
    const end = () => t.call("DELETE", `/auth/sessions/${other?.id}`, undefined, { cookie });
    expect((await end()).status).toBe(200);
    expect(await works({ cookie: againCookie })).toBe(false);
    expect((await end()).status).toBe(404);
  });
});
