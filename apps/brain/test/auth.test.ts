import { describe, expect, test } from "bun:test";
import { setUpOwner, testApp } from "./helpers";

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

  test("wrong password fails", async () => {
    const t = await testApp();
    const { secret } = await setUpOwner(t);
    expect(
      (await t.call("POST", "/auth/login", { password: "nope", totp: t.code(secret) })).status,
    ).toBe(401);
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
