import { describe, expect, test } from "bun:test";
import { ORIGIN, setUpOwner, testApp } from "./helpers";

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
