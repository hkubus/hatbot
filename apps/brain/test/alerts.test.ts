import { expect, test } from "bun:test";
import type { Task } from "@hatbot/shared";
import { FakeModel, toolUse } from "./fake-model";
import { testApp, waitFor } from "./helpers";

const down = { heartbeat: { status: 0, msg: "timeout" }, monitor: { id: 3, name: "Jellyfin" } };
const up = { heartbeat: { status: 1, msg: "200 OK" }, monitor: { id: 3, name: "Jellyfin" } };
const done = (summary: string) => ({
  content: [toolUse("finish_task", { outcome: "done", summary, notify: true })],
});

test("the last dollar of the day is kept for alerts; past it, you still hear what the alert said", async () => {
  const work = new FakeModel([done("Restarted.")]);
  const t = await testApp(new FakeModel(), work);
  const spent = (usd: number) =>
    t.db
      .query(
        `INSERT INTO spend_ledger (created_at, model, purpose, input_tokens, cache_write_5m_tokens, cache_write_1h_tokens, cache_read_tokens, output_tokens, cost_usd, bot_id)
         VALUES ('2026-10-09T12:00:00.000Z', 'm', 'chat', 0, 0, 0, 0, 0, ?, 'hatbot')`,
      )
      .run(usd);
  const ended = async (task: Task | null) =>
    waitFor(() => {
      const now = t.tasks.get(task?.id ?? 0);
      return now?.finishedAt ? now : null;
    });
  const triggerId = t.triggers.create({ name: "Kuma", kind: "kuma", prompt: "Fix it" }).id;
  const alert = (id: number, name: string, msg: string) =>
    (
      t.triggers.receiveKuma(triggerId, {
        heartbeat: { status: 0, msg },
        monitor: { id, name, url: `http://${name.toLowerCase()}.lan` },
      }) as { task: Task }
    ).task;

  spent(9.5);
  const chat = t.tasks.createBackgroundTask({ title: "Tidy", goal: "g", origin: "chat" });
  expect((await ended(chat)).status).toBe("failed");
  expect((await ended(alert(3, "Jellyfin", "timeout"))).status).toBe("done");
  spent(0.5);
  expect((await ended(alert(4, "Immich", "connection refused"))).status).toBe("failed");
  expect(t.notifier.sent.at(-1)?.message).toContain("Immich (http://immich.lan) is down");
  expect(work.requests).toHaveLength(1);

  // Limits saved before the reserve existed get it; one limit changes without the others.
  t.db
    .query(
      "UPDATE settings SET value = json_remove(value, '$.limits.alertReserveUsd') WHERE key = 'app'",
    )
    .run();
  expect(t.settings.get().limits.alertReserveUsd).toBe(1);
  expect(t.settings.update({ limits: { alertReserveUsd: 0 } }).limits).toMatchObject({
    dailyUsd: 10,
    alertReserveUsd: 0,
  });
});

test("a flapping monitor goes on its last task's timeline for an hour; a trigger starts 24 tasks a day at most", async () => {
  const work = new FakeModel(["1", "2", "3", "4"].map(done));
  const t = await testApp(new FakeModel(), work);
  const triggerId = t.triggers.create({ name: "Kuma", kind: "kuma", prompt: "Fix it" }).id;
  const first = t.triggers.receiveKuma(triggerId, down);
  if (first.status !== "started") throw new Error(first.status);
  await waitFor(() => t.tasks.get(first.task.id)?.finishedAt);

  // Back up and down again ten minutes later: on that task's timeline, and you're told, once.
  t.advance(10 * 60_000);
  expect(t.triggers.receiveKuma(triggerId, up)).toEqual({ status: "skipped", reason: "ignored" });
  expect(t.triggers.receiveKuma(triggerId, down)).toEqual({ status: "skipped", reason: "recent" });
  expect(t.tasks.steps(first.task.id).map((s) => s.name)).toEqual(
    expect.arrayContaining(["Jellyfin is back up", "Jellyfin is down again"]),
  );
  t.advance(60_000);
  t.triggers.receiveKuma(triggerId, up);
  t.triggers.receiveKuma(triggerId, down);
  const downAgain = t.notifier.sent.filter((n) => n.title === "Jellyfin is down again");
  expect(downAgain).toHaveLength(1);
  expect(downAgain[0]?.click).toContain(`/tasks/${first.task.id}`);
  // Kuma says nothing more while it stays down. An hour after the task ended, a new one.
  t.advance(40 * 60_000);
  t.triggers.tick();
  expect(t.tasks.list()).toHaveLength(1);
  t.advance(10 * 60_000);
  t.triggers.tick();
  expect(t.tasks.list()).toHaveLength(2);
  await t.tasks.idle();

  // 22 more today, as if other monitors had gone down: the 24th is the last, and you're told once.
  for (let i = 0; i < 21; i++)
    t.db
      .query(
        `INSERT INTO tasks (title, goal, success_criteria, origin, lane, model, status, budget_usd, created_at, finished_at, trigger_id, run_key)
         VALUES ('Other is down', 'g', '', 'alert', 'background', 'm', 'done', 1, ?, ?, ?, ?)`,
      )
      .run("2026-10-09T13:00:00.000Z", "2026-10-09T13:00:00.000Z", triggerId, `kuma:${i}`);
  const other = (id: number) => ({
    heartbeat: { status: 0, msg: "timeout" },
    monitor: { id, name: `Monitor ${id}` },
  });
  expect(t.triggers.receiveKuma(triggerId, other(7)).status).toBe("started");
  expect(t.triggers.receiveKuma(triggerId, other(8))).toEqual({
    status: "skipped",
    reason: "limit",
  });
  expect(t.notifier.sent.filter((n) => n.title === "Kuma is at its limit")).toHaveLength(1);
  await t.tasks.idle();
  t.advance(24 * 3600_000);
  expect(t.triggers.receiveKuma(triggerId, other(8)).status).toBe("started");
  await t.tasks.idle();
});
