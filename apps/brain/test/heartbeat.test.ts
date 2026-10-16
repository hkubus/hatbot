import { expect, test } from "bun:test";
import { z } from "zod";
import { definePlugin, ready } from "../src/plugins/plugin";
import { FakeModel, toolUse } from "./fake-model";
import { setUpOwner, type TestApp, testApp, waitFor } from "./helpers";

/** A plugin whose monitors are down while `down` has them. */
function kuma(down: string[]) {
  return definePlugin({
    id: "kuma",
    name: "Kuma",
    description: "",
    config: z.object({}),
    start: () =>
      ready([], {
        signals: async () => down.map((name) => ({ key: `down:${name}`, text: `${name} is down` })),
      }),
  });
}

async function on(t: TestApp) {
  // The desktop answers.
  await t.desktop.refresh();
  t.settings.update({
    heartbeat: { ...t.settings.get().heartbeat, enabled: true, everyMinutes: 30 },
  });
}

test("the heartbeat tells you once about something new, and again only after it came back", async () => {
  const down = ["Jellyfin"];
  const t = await testApp(new FakeModel(), new FakeModel(), {}, [kuma(down)]);
  await t.plugins.update("kuma", { enabled: true });
  await on(t);
  t.taskModel.onCreate = () => '{"action": "notify", "message": "Jellyfin is down."}';

  const first = await t.heartbeat.run();
  expect(first).toMatchObject({
    action: "notify",
    found: ["Jellyfin is down"],
    note: "Jellyfin is down.",
  });
  expect(t.notifier.sent.at(-1)).toMatchObject({
    title: "Heartbeat",
    message: "Jellyfin is down.",
  });
  expect(t.thread.list().at(-1)?.text).toBe("**Heartbeat**: Jellyfin is down.");
  const calls = t.taskModel.creates.length;

  // Still down: nothing new, so no model call.
  t.advance(30 * 60_000);
  expect((await t.heartbeat.run()).action).toBe("nothing");
  expect(t.taskModel.creates.length).toBe(calls);

  // Back up, then down again: told again.
  down.length = 0;
  await t.heartbeat.run();
  down.push("Jellyfin");
  await t.heartbeat.run();
  expect(t.notifier.sent.filter((n) => n.title === "Heartbeat")).toHaveLength(2);
  // The looks that found something are kept, newest first, and each look tells the clients.
  const info = t.heartbeat.info();
  expect(info.recent.map((r) => r.action)).toEqual(["notify", "notify"]);
  expect(info.recent[0]?.found).toEqual(["Jellyfin is down"]);
  expect(t.events.filter((e) => e.type === "heartbeat.updated")).toHaveLength(4);
});

test("after a long time off, the heartbeat only looks at the last two intervals", async () => {
  const t = await testApp();
  await on(t);
  t.taskModel.onCreate = () => '{"action": "nothing", "message": ""}';
  const failed = (title: string, finished: string) =>
    t.db
      .query(
        `INSERT INTO tasks (title, goal, success_criteria, origin, lane, model, status, budget_usd, created_at, finished_at)
         VALUES (?, 'g', '', 'schedule', 'background', 'm', 'failed', 1, ?, ?)`,
      )
      .run(title, finished, finished);
  failed("Old", "2026-10-09T10:00:00.000Z");
  failed("Recent", "2026-10-09T11:30:00.000Z");
  await t.heartbeat.run();
  t.advance(3 * 24 * 3600_000);
  failed("Days ago", "2026-10-10T12:00:00.000Z");
  failed("Just now", new Date(Date.parse("2026-10-12T11:50:00Z")).toISOString());
  const later = await t.heartbeat.run();
  expect(later.found).toEqual(['Task #4 "Just now" failed']);
  expect(t.heartbeat.info().recent.map((r) => r.found)).toEqual([
    ['Task #4 "Just now" failed'],
    ['Task #2 "Recent" failed'],
  ]);
});

test("a failed task wakes Haiku, which can start a tainted heartbeat task", async () => {
  const work = new FakeModel([
    { content: [toolUse("finish_task", { outcome: "done", summary: "Looked.", notify: false })] },
  ]);
  const t = await testApp(new FakeModel(), work);
  const { cookie } = await setUpOwner(t);
  await on(t);
  t.taskModel.onCreate = () =>
    '{"action": "task", "title": "Why the backup failed", "message": "Check the backup task."}';
  t.db
    .query(
      `INSERT INTO tasks (title, goal, success_criteria, origin, lane, model, status, budget_usd, created_at, finished_at, summary)
       VALUES ('Nightly backup', 'g', '', 'schedule', 'background', 'm', 'failed', 1, ?, ?, 'No space left')`,
    )
    .run(new Date(Date.now()).toISOString(), "2026-10-09T12:00:00.000Z");

  const res = await t.call("POST", "/heartbeat/run", undefined, { cookie });
  const info = (await res.json()) as { action: string; taskId: number; found: string[] };
  expect(info.found).toEqual(['Task #1 "Nightly backup" failed: No space left']);
  expect(info.action).toBe("task");
  const task = t.tasks.get(info.taskId);
  expect(task).toMatchObject({
    origin: "heartbeat",
    title: "Why the backup failed",
    tainted: true,
  });
  expect(task?.goal).toBe(t.settings.get().heartbeat.instructions);
  expect(task?.payload).toContain("No space left");
  await waitFor(() => t.tasks.get(info.taskId)?.finishedAt);
  // It doesn't look at its own failures.
  expect(t.taskModel.creates.at(-1)?.model).toBe("claude-haiku-5-5");
});

test("it's on by default, and runs only when it's on and due", async () => {
  const t = await testApp();
  expect(t.settings.get().heartbeat.enabled).toBe(true);
  t.settings.update({ heartbeat: { ...t.settings.get().heartbeat, enabled: false } });
  t.heartbeat.tick();
  await Bun.sleep(5);
  expect(t.heartbeat.info().at).toBeNull();
  await on(t);
  t.heartbeat.tick();
  await waitFor(() => t.heartbeat.info().at);
  const at = t.heartbeat.info().at;
  t.advance(10 * 60_000);
  t.heartbeat.tick();
  await Bun.sleep(5);
  expect(t.heartbeat.info().at).toBe(at);
});

test("the weekly report sums up the week without the model, once, when it's due", async () => {
  const t = await testApp();
  t.db
    .query(
      `INSERT INTO tasks (title, goal, success_criteria, origin, lane, model, status, budget_usd, created_at)
       VALUES ('A', 'g', '', 'chat', 'background', 'm', 'done', 1, '2026-10-08T00:00:00Z'),
              ('B', 'g', '', 'chat', 'background', 'm', 'failed', 1, '2026-10-08T00:00:00Z')`,
    )
    .run();
  t.db
    .query(
      `INSERT INTO spend_ledger (created_at, model, purpose, input_tokens, cache_write_5m_tokens, cache_write_1h_tokens, cache_read_tokens, output_tokens, cost_usd, bot_id)
       VALUES ('2026-10-08T00:00:00Z', 'm', 'chat', 0, 0, 0, 0, 0, 1.5, 'hatbot')`,
    )
    .run();
  const { text, line } = await t.report.make();
  expect(text).toContain("Spent $1.50.");
  expect(text).toContain("2 tasks: 1 done, 1 failed.");
  expect(text).toContain("Failed: [B](/tasks/2)");
  expect(line).toBe("$1.50 spent, 2 tasks (1 failed).");
  expect(t.taskModel.creates).toHaveLength(0);

  // 2026-10-09 is a Friday; due Fridays at 13:00 local.
  const local = new Date(Date.parse("2026-10-09T12:00:00Z"));
  t.settings.update({
    weeklyReport: { enabled: true, weekday: 5, hour: (local.getHours() + 1) % 24 },
  });
  t.report.tick();
  await Bun.sleep(5);
  expect(t.notifier.sent).toHaveLength(0);
  t.advance(61 * 60_000);
  t.report.tick();
  await waitFor(() => t.notifier.sent.length);
  expect(t.notifier.sent[0]).toMatchObject({ title: "Your week" });
  t.advance(60_000);
  t.report.tick();
  await Bun.sleep(5);
  expect(t.notifier.sent).toHaveLength(1);
});
