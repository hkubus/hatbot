import { expect, test } from "bun:test";
import type { Approval, CheckReport, ChecksInfo } from "@hatbot/shared";
import { Checks } from "../src/checks";
import { NtfyNotifier } from "../src/notify";
import { ORIGIN, setUpOwner, type TestApp, testApp } from "./helpers";

const byId = (r: CheckReport) => Object.fromEntries(r.results.map((c) => [c.id, c]));

test("Check everything tries each part and keeps the report, and a test approval's answer shows", async () => {
  const t = await testApp();
  const { cookie } = await setUpOwner(t);
  t.agent.health = {
    version: "abc1234",
    profile: "hatbot",
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    features: ["profiles", "exec", "files", "fields", "render", "gates"],
  };
  // The model call is a real one: it holds what it may cost while it runs, so a request made
  // meanwhile can't pass a limit with it.
  t.settings.update({ limits: { ...t.settings.get().limits, dailyUsd: 1, alertReserveUsd: 0 } });
  let meanwhile: unknown = null;
  t.taskModel.onCreate = () => {
    try {
      t.spend.check(0.9995);
    } catch (err) {
      meanwhile = err;
    }
    return "OK";
  };
  const res = await t.call("POST", "/checks", undefined, { cookie });
  expect(res.status).toBe(200);
  const checks = byId((await res.json()) as CheckReport);
  // All is well, but for parts not set up in tests: skipped, or ntfy's said plainly, not failed.
  const notOk = Object.values(checks).filter((c) => c.state !== "ok" && c.state !== "skip");
  expect(notOk.map((c) => [c.id, c.state])).toEqual([["notifications", "warn"]]);
  expect(checks.model?.state).toBe("ok");
  expect(meanwhile).not.toBeNull();
  expect(() => t.spend.check(0.9995)).not.toThrow();
  // The site only: a page's address can carry what you typed, and the report is kept.
  expect(checks["desktop.browser"]?.detail).toContain("on example.com.");
  expect(checks["desktop.browser"]?.detail).not.toContain("https://");
  const info = (await (await t.call("GET", "/checks", undefined, { cookie })).json()) as ChecksInfo;
  expect(info.report?.results.length).toBe(Object.keys(checks).length);
  // Plain lines for infra/smoke.sh.
  const text = await (await t.call("POST", "/checks?text=1", undefined, { cookie })).text();
  expect(text).toContain("ok    Database: Schema version");
  // A part that's down fails: here Chromium's DevTools.
  t.agent.health = { ok: false, x: true, cdp: false };
  expect(byId(await t.checks.run()).desktop?.state).toBe("fail");

  const a = (await (
    await t.call("POST", "/checks/approval", undefined, { cookie })
  ).json()) as Approval;
  expect(a.status).toBe("pending");
  expect(t.notifier.sent.at(-1)?.actions).toHaveLength(3);
  await t.call("POST", `/approvals/${a.id}`, { decision: "approve" }, { cookie });
  const after = (await (
    await t.call("GET", "/checks", undefined, { cookie })
  ).json()) as ChecksInfo;
  expect(after.approval?.status).toBe("approved");
});

/**
 * Check everything's ntfy line, against a server that answers each path as `answers` says; 0 is no
 * answer in time.
 */
async function ntfyCheck(t: TestApp, env: Record<string, string>, answers: Record<string, number>) {
  const asked: { url: string; auth: string | null; body: string }[] = [];
  const fetcher = (async (url: string, init?: RequestInit) => {
    asked.push({
      url,
      auth: new Headers(init?.headers).get("authorization"),
      body: String(init?.body),
    });
    const path = new URL(url).pathname;
    const status = answers[path] ?? 404;
    if (status === 0) throw new DOMException("The operation timed out.", "TimeoutError");
    return path === "/v1/health"
      ? Response.json({ healthy: status === 200 }, { status })
      : new Response("", { status });
  }) as typeof fetch;
  const ntfy = new NtfyNotifier({ NTFY_URL: "https://ntfy.test", ...env }, fetcher);
  const checks = new Checks({
    db: t.db,
    config: { publicUrl: ORIGIN },
    settings: t.settings,
    spend: t.spend,
    model: t.taskModel,
    memory: t.memory,
    archive: t.archive,
    storage: t.storage,
    desktop: t.desktop,
    plugins: t.plugins,
    approvals: t.approvals,
    proxmox: t.proxmox,
    updates: t.updates,
    ntfy,
  });
  return { state: byId(await checks.run()).notifications?.state, asked, ntfy };
}

test("ntfy: a topic anyone can read or guess fails the check, one with no token or an unclear answer warns", async () => {
  const t = await testApp();
  const random = "hatbot-0f3a9c2e5b7d41a8c6e0f2b4";
  const check = async (env: Record<string, string>, topicAnswers: number) => {
    const topic = env.NTFY_TOPIC ?? "";
    return ntfyCheck(t, env, { "/v1/health": 200, [`/${topic}/json`]: topicAnswers });
  };
  const token = { NTFY_TOKEN: "tk_1" };
  // Open to anyone: the look at it goes without the token, and asks only for what's new.
  const shared = await check({ NTFY_TOPIC: "hatbot", ...token }, 200);
  expect(shared.state).toBe("fail");
  const probe = shared.asked.find((a) => a.url.includes("/hatbot/json"));
  expect(probe?.auth).toBeNull();
  expect(probe?.url).toContain("poll=1&since=");
  expect((await check({ NTFY_TOPIC: random, ...token }, 200)).state).toBe("warn");
  // Closed to strangers, as it should be; but not without a token to send with.
  expect((await check({ NTFY_TOPIC: random, ...token }, 403)).state).toBe("ok");
  expect((await check({ NTFY_TOPIC: random }, 403)).state).toBe("warn");
  // An answer that doesn't say isn't taken as closed; a name picked by hand can be guessed anyway.
  expect((await check({ NTFY_TOPIC: random, ...token }, 429)).state).toBe("warn");
  expect((await check({ NTFY_TOPIC: random, ...token }, 0)).state).toBe("warn");
  expect((await check({ NTFY_TOPIC: "hatbot-notifications", ...token }, 429)).state).toBe("fail");

  // No topic fails, and nothing is sent: there's no shared default.
  const none = await check({}, 403);
  expect(none.state).toBe("fail");
  await none.ntfy.send({ title: "x", message: "" });
  expect(none.asked.filter((a) => a.body.includes('"title"'))).toEqual([]);
});
