import { expect, test } from "bun:test";
import type { Approval, CheckReport, ChecksInfo } from "@hatbot/shared";
import { DesktopError } from "../src/desktop/client";
import { setUpOwner, testApp } from "./helpers";

const byId = (r: CheckReport) => Object.fromEntries(r.results.map((c) => [c.id, c]));

test("Check everything tries each part and keeps the report", async () => {
  const t = await testApp();
  const { cookie } = await setUpOwner(t);
  t.agent.health = {
    version: "abc1234",
    profile: "hatbot",
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    features: ["profiles", "exec", "files", "fields", "render", "gates"],
  };
  const res = await t.call("POST", "/checks", undefined, { cookie });
  expect(res.status).toBe(200);
  const checks = byId((await res.json()) as CheckReport);
  expect(checks.database?.state).toBe("ok");
  expect(checks.model?.state).toBe("ok");
  expect(checks.memory?.state).toBe("ok");
  expect(checks.archive?.state).toBe("ok");
  expect(checks.desktop?.state).toBe("ok");
  expect(checks["desktop.profiles"]?.state).toBe("ok");
  expect(checks["desktop.shell"]?.state).toBe("ok");
  expect(checks["desktop.render"]?.state).toBe("ok");
  expect(checks["desktop.browser"]?.detail).toContain("https://example.com/");
  expect(checks["public-url"]?.state).toBe("ok");
  // Not set up in tests: said plainly, not failed.
  expect(checks.notifications?.state).toBe("warn");
  // The model call is a real one, so it's in the ledger.
  expect(t.taskModel.creates.at(-1)?.model).toBe("claude-haiku-5-5");
  const info = (await (await t.call("GET", "/checks", undefined, { cookie })).json()) as ChecksInfo;
  expect(info.report?.results.length).toBe(Object.keys(checks).length);
});

test("an old desktop, a shared profile and a broken schedule are flagged", async () => {
  const t = await testApp();
  const { cookie } = await setUpOwner(t);
  t.agent.health = { profile: null, timeZone: "Pacific/Chatham", features: ["exec"] };
  const s = t.schedules.create(
    { name: "Stock check", prompt: "Check", cron: "0 8 * * *" },
    "owner",
  );
  for (let i = 0; i < 3; i++)
    t.db
      .query(
        "INSERT INTO tasks (title, goal, success_criteria, origin, lane, model, status, budget_usd, created_at, schedule_id) VALUES ('x', 'x', '', 'schedule', 'background', 'm', 'failed', 1, '2026-10-09', ?)",
      )
      .run(s.id);
  const checks = byId(
    (await (await t.call("POST", "/checks", undefined, { cookie })).json()) as CheckReport,
  );
  expect(checks.desktop?.detail).toContain("older than the brain");
  expect(checks["desktop.profiles"]?.state).toBe("warn");
  expect(checks["desktop.timezone"]?.detail).toContain("Pacific/Chatham");
  expect(checks["desktop.render"]).toMatchObject({ state: "warn" });
  expect(checks["desktop.render"]?.detail).toContain("too old");
  expect(checks.schedules?.detail).toContain('"Stock check"');

  // The deep health check: Chromium's DevTools down.
  t.agent.health = { ok: false, x: true, cdp: false };
  const again = byId(await t.checks.run());
  expect(again.desktop).toMatchObject({ state: "fail" });
  expect(again.desktop?.detail).toContain("DevTools");
});

test("the renderer is tried with a page of the desktop's own", async () => {
  const t = await testApp();
  t.agent.health = { features: ["profiles", "exec", "files", "render"] };
  t.agent.renderError = new DesktopError("The renderer isn't running (deploy.sh sets it up).", 503);
  expect(byId(await t.checks.run())["desktop.render"]).toMatchObject({
    state: "fail",
    detail: "The renderer isn't running. Run infra/deploy.sh once on the host.",
  });
  t.agent.renderError = new DesktopError("Chromium failed: No usable sandbox!", 500);
  expect(byId(await t.checks.run())["desktop.render"]).toMatchObject({
    state: "fail",
    detail: "Chromium failed: No usable sandbox!",
  });
});

test("a test approval goes out, and its answer shows", async () => {
  const t = await testApp();
  const { cookie } = await setUpOwner(t);
  const a = (await (
    await t.call("POST", "/checks/approval", undefined, { cookie })
  ).json()) as Approval;
  expect(a.status).toBe("pending");
  expect(t.notifier.sent.at(-1)?.actions?.map((b) => b.label)).toEqual(["Approve", "Deny"]);
  await t.call("POST", `/approvals/${a.id}`, { decision: "approve" }, { cookie });
  const info = (await (await t.call("GET", "/checks", undefined, { cookie })).json()) as ChecksInfo;
  expect(info.approval?.status).toBe("approved");
  // A second one replaces a first that's still waiting.
  const b = (await (
    await t.call("POST", "/checks/approval", undefined, { cookie })
  ).json()) as Approval;
  const c = (await (
    await t.call("POST", "/checks/approval", undefined, { cookie })
  ).json()) as Approval;
  expect(t.approvals.get(b.id)?.status).toBe("cancelled");
  expect(c.status).toBe("pending");
});

test("plain lines for infra/smoke.sh", async () => {
  const t = await testApp();
  const { cookie } = await setUpOwner(t);
  const text = await (await t.call("POST", "/checks?text=1", undefined, { cookie })).text();
  expect(text).toContain("ok    Database: Schema version");
});
