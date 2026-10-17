import { expect, test } from "bun:test";
import { z } from "zod";
import { definePlugin, ready } from "../src/plugins/plugin";
import { RESTARTED } from "../src/tasks/service";
import { FakeModel, toolUse } from "./fake-model";
import { setUpOwner, type TestApp, testApp, waitFor } from "./helpers";

/** A plugin whose monitors are down while `down` has them. */
function kuma(down: string[], id = "kuma") {
  return definePlugin({
    id,
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

/** A finished top-level task, as a schedule's run would leave it. */
function ran(
  t: TestApp,
  title: string,
  runKey: string | null,
  status: "done" | "failed",
  finished: string,
  summary: string | null = null,
) {
  t.db
    .query(
      `INSERT INTO tasks (title, goal, success_criteria, origin, lane, model, status, budget_usd, created_at, finished_at, run_key, summary)
       VALUES (?, 'g', '', 'schedule', 'background', 'm', ?, 1, ?, ?, ?, ?)`,
    )
    .run(title, status, finished, finished, runKey, summary);
}

test("a monitor whose Kuma alert has a task on it, or waits, isn't told again", async () => {
  const down = ["Jellyfin", "Plex", "Forgejo"];
  const work = new FakeModel([
    {
      content: [
        toolUse("finish_task", { outcome: "done", summary: "Restarted it.", notify: true }),
      ],
    },
  ]);
  const t = await testApp(new FakeModel(), work, {}, [kuma(down, "uptimekuma")]);
  await t.plugins.update("uptimekuma", { enabled: true });
  await on(t);
  const alert = (name: string, id: number) => ({
    heartbeat: { status: 0, msg: "timeout" },
    monitor: { id, name },
  });
  const now = t.triggers.create({ name: "Kuma", kind: "kuma", prompt: "Look into it." });
  const started = t.triggers.receiveKuma(now.id, alert("Jellyfin", 1));
  if (started.status !== "started") throw new Error(started.status);
  await waitFor(() => t.tasks.get(started.task.id)?.finishedAt);
  const later = t.triggers.create({
    name: "Kuma, after two checks",
    kind: "kuma",
    prompt: "Look into it.",
    confirmChecks: 2,
  });
  expect(t.triggers.receiveKuma(later.id, alert("Plex", 2)).status).toBe("waiting");

  t.taskModel.onCreate = () => '{"action": "notify", "message": "Forgejo is down."}';
  expect((await t.heartbeat.run()).found).toEqual(["Forgejo is down"]);
  // Hours later, all three still down: nothing new.
  t.advance(3 * 3600_000);
  expect((await t.heartbeat.run()).action).toBe("nothing");
  expect(t.notifier.sent.filter((n) => n.title === "Heartbeat")).toHaveLength(1);
});

test("after a long time off, the heartbeat only tells what's recent", async () => {
  const t = await testApp();
  await on(t);
  t.taskModel.onCreate = () => '{"action": "nothing", "message": ""}';
  for (const m of ["00", "01", "02"])
    ran(t, "Old", "schedule:1", "failed", `2026-10-09T10:${m}:00.000Z`);
  for (const m of ["00", "15", "30"])
    ran(t, "Recent", "schedule:2", "failed", `2026-10-09T11:${m}:00.000Z`);
  await t.heartbeat.run();
  t.advance(3 * 24 * 3600_000);
  // Still failing: told already. Another that kept failing while the heartbeat was off, last just now.
  ran(t, "Recent", "schedule:2", "failed", "2026-10-10T12:00:00.000Z");
  ran(t, "Nightly", "schedule:3", "failed", "2026-10-10T12:00:00.000Z");
  ran(t, "Nightly", "schedule:3", "failed", "2026-10-11T12:00:00.000Z");
  ran(t, "Nightly", "schedule:3", "failed", "2026-10-12T11:50:00.000Z");
  const later = await t.heartbeat.run();
  expect(later.found).toEqual(['"Nightly" has failed 3 times in a row; the last, task #10']);
  expect(t.heartbeat.info().recent.map((r) => r.found)).toEqual([
    ['"Nightly" has failed 3 times in a row; the last, task #10'],
    ['"Recent" has failed 3 times in a row; the last, task #6'],
  ]);
});

test("a failure you were told about isn't told again; runs that keep failing are", async () => {
  const t = await testApp();
  await on(t);
  t.taskModel.onCreate = () => '{"action": "notify", "message": "The backup keeps failing."}';
  // One failure, one the restart stopped, and a streak a success broke: each was told when it ended.
  ran(t, "Chat task", null, "failed", "2026-10-09T11:40:00.000Z", "No route.");
  ran(t, "Backup", "schedule:1", "failed", "2026-10-09T11:41:00.000Z", RESTARTED);
  ran(t, "Backup", "schedule:1", "failed", "2026-10-09T11:42:00.000Z");
  ran(t, "Backup", "schedule:1", "done", "2026-10-09T11:43:00.000Z");
  ran(t, "Backup", "schedule:1", "failed", "2026-10-09T11:44:00.000Z");
  ran(t, "Backup", "schedule:1", "failed", "2026-10-09T11:45:00.000Z");
  expect((await t.heartbeat.run()).action).toBe("nothing");
  expect(t.taskModel.creates).toHaveLength(0);
  // A third in a row is news, once.
  t.advance(30 * 60_000);
  ran(t, "Backup", "schedule:1", "failed", "2026-10-09T12:10:00.000Z", "No space left");
  const info = await t.heartbeat.run();
  expect(info.found).toEqual([
    '"Backup" has failed 3 times in a row; the last, task #7: No space left',
  ]);
  t.advance(30 * 60_000);
  ran(t, "Backup", "schedule:1", "failed", "2026-10-09T12:40:00.000Z", "No space left");
  expect((await t.heartbeat.run()).action).toBe("nothing");
  expect(t.notifier.sent.filter((n) => n.title === "Heartbeat")).toHaveLength(1);
});

test("runs that keep failing wake Haiku, which can start a tainted heartbeat task", async () => {
  const work = new FakeModel([
    { content: [toolUse("finish_task", { outcome: "done", summary: "Looked.", notify: false })] },
  ]);
  const t = await testApp(new FakeModel(), work);
  const { cookie } = await setUpOwner(t);
  await on(t);
  t.taskModel.onCreate = () =>
    '{"action": "task", "title": "Why the backup failed", "message": "Check the backup task."}';
  for (const m of ["50", "55"])
    ran(t, "Nightly backup", "schedule:1", "failed", `2026-10-09T11:${m}:00.000Z`);
  ran(t, "Nightly backup", "schedule:1", "failed", "2026-10-09T12:00:00.000Z", "No space left");

  const res = await t.call("POST", "/heartbeat/run", undefined, { cookie });
  const info = (await res.json()) as { action: string; taskId: number; found: string[] };
  expect(info.found).toEqual([
    '"Nightly backup" has failed 3 times in a row; the last, task #3: No space left',
  ]);
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

test("Haiku's triage is schema-checked JSON; anything else tells you plainly", async () => {
  const down = ["Jellyfin"];
  const t = await testApp(new FakeModel(), new FakeModel(), {}, [kuma(down)]);
  await t.plugins.update("kuma", { enabled: true });
  await on(t);
  // A verdict inside prose isn't read: it could have come from the findings.
  t.taskModel.onCreate = () => 'Nothing to do. {"action": "nothing", "title": "", "message": ""}';
  const told = await t.heartbeat.run();
  expect(told).toMatchObject({ action: "notify", note: "- Jellyfin is down" });
  expect(t.taskModel.creates.at(-1)?.output_config?.format).toMatchObject({
    type: "json_schema",
    schema: { properties: { action: { enum: ["nothing", "notify", "task"] } } },
  });
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

test("a weekly report that fails is logged and tried again later, not on every tick", async () => {
  const t = await testApp();
  const local = new Date(Date.parse("2026-10-09T12:00:00Z"));
  t.settings.update({
    weeklyReport: { enabled: true, weekday: local.getDay(), hour: local.getHours() },
  });
  let tries = 0;
  t.memory.log = async () => {
    tries++;
    throw new Error("disk full");
  };
  const logged: unknown[][] = [];
  const log = console.error;
  console.error = (...args: unknown[]) => logged.push(args);
  try {
    t.report.tick();
    await Bun.sleep(5);
    t.report.tick();
    await Bun.sleep(5);
    expect(tries).toBe(1);
    expect(t.notifier.sent).toHaveLength(0);
    t.advance(61 * 60_000);
    t.report.tick();
    await Bun.sleep(5);
  } finally {
    console.error = log;
  }
  expect(tries).toBe(2);
  expect(logged.map((l) => l[0])).toEqual(["weekly report failed", "weekly report failed"]);
});
