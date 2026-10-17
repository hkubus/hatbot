import { expect, test } from "bun:test";
import type { Task } from "@hatbot/shared";
import { z } from "zod";
import { REVIEW_PROMPT } from "../src/agent/prompt";
import { definePlugin, ready, tool } from "../src/plugins/plugin";
import { FakeModel, toolUse } from "./fake-model";
import { type TestApp, testApp, waitFor } from "./helpers";

const down = { heartbeat: { status: 0, msg: "timeout" }, monitor: { id: 3, name: "Jellyfin" } };
const up = { heartbeat: { status: 1, msg: "200 OK" }, monitor: { id: 3, name: "Jellyfin" } };

test("a Kuma alert: the task investigates, restarts, and hears that the monitor is back", async () => {
  let app: TestApp | null = null;
  let triggerId = 0;
  const restarted: string[] = [];
  // Restarting brings the monitor back: Kuma says so while the task is still running.
  const lab = definePlugin({
    id: "lab",
    name: "Lab",
    description: "",
    config: z.object({}),
    start: () =>
      ready([
        tool({
          name: "lab_logs",
          description: "",
          access: "read",
          schema: z.object({}),
          run: async () => "jellyfin: out of memory, killed",
        }),
        tool({
          name: "lab_restart",
          description: "",
          access: "write",
          schema: z.object({ service: z.string() }),
          run: async ({ service }) => {
            restarted.push(service);
            app?.triggers.receiveKuma(triggerId, up);
            return `Restarted ${service}.`;
          },
        }),
      ]),
  });
  const work = new FakeModel([
    { content: [toolUse("lab_logs", {})] },
    { content: [toolUse("lab_restart", { service: "jellyfin" })] },
    {
      content: [
        toolUse("finish_task", {
          outcome: "done",
          summary: "Jellyfin ran out of memory; restarted it and it's back.",
          notify: true,
        }),
      ],
    },
  ]);
  // The alert's message taints the task, so Haiku reviews the restart, and lets it through.
  work.onCreate = (p) =>
    p.system === REVIEW_PROMPT
      ? '{"safe": true, "why": "A restart."}'
      : '{"suspected": false, "excerpt": ""}';
  const t = await testApp(new FakeModel(), work, {}, [lab]);
  app = t;
  await t.plugins.update("lab", { enabled: true });
  triggerId = t.triggers.create({ name: "Kuma", kind: "kuma", prompt: "Fix it" }).id;

  const r = t.triggers.receiveKuma(triggerId, down);
  expect(r.status).toBe("started");
  const task = (r as { task: Task }).task;
  await waitFor(() => t.tasks.get(task.id)?.finishedAt);

  expect(restarted).toEqual(["jellyfin"]);
  // The alert task got the plugin tools, and the "back up" event arrived with the restart's result.
  expect(work.requests[0]?.tools?.map((x) => (x as { name: string }).name)).toContain(
    "lab_restart",
  );
  const after = JSON.stringify(work.requests[2]?.messages.at(-1));
  expect(after).toContain("Restarted jellyfin.");
  expect(after).toContain('<event trusted=\\"true\\">');
  expect(after).toContain("is back up");
  expect(t.tasks.steps(task.id).some((s) => s.name === "Jellyfin is back up")).toBe(true);
  expect(t.notifier.sent.at(-1)?.title).toBe("Done: Jellyfin is down");
});

test("code tasks get more room than routine ones", async () => {
  const work = new FakeModel([
    { content: [toolUse("finish_task", { outcome: "done", summary: "PR opened.", notify: true })] },
  ]);
  const t = await testApp(new FakeModel(), work);
  t.tasks.createBackgroundTask({ title: "Fix CI", goal: "Fix it", origin: "chat", effort: "high" });
  await t.tasks.idle();
  expect(work.requests[0]?.max_tokens).toBe(32000);
  expect(work.requests[0]?.output_config?.effort).toBe("high");
});

test("the last dollar of the day is kept for alerts; past it, you still hear what the alert said", async () => {
  const work = new FakeModel([
    { content: [toolUse("finish_task", { outcome: "done", summary: "Restarted.", notify: true })] },
  ]);
  const t = await testApp(new FakeModel(), work);
  const spent = (usd: number) =>
    t.db
      .query(
        `INSERT INTO spend_ledger (created_at, model, purpose, input_tokens, cache_write_5m_tokens, cache_write_1h_tokens, cache_read_tokens, output_tokens, cost_usd, bot_id)
         VALUES ('2026-10-09T12:00:00.000Z', 'm', 'chat', 0, 0, 0, 0, 0, ?, 'hatbot')`,
      )
      .run(usd);
  const ended = async (task: Task | null) => {
    await waitFor(() => t.tasks.get(task?.id ?? 0)?.finishedAt);
    return t.tasks.get(task?.id ?? 0);
  };
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
  expect(await ended(chat)).toMatchObject({
    status: "failed",
    summary: "Stopped: Today's $10 limit would be exceeded (its last $1 is kept for alerts).",
  });
  expect(await ended(alert(3, "Jellyfin", "timeout"))).toMatchObject({ status: "done" });

  spent(0.5);
  expect(await ended(alert(4, "Immich", "connection refused"))).toMatchObject({
    status: "failed",
  });
  expect(t.notifier.sent.at(-1)).toMatchObject({
    title: "Failed: Immich is down",
    message:
      "Not investigated: today's limit is spent. The alert: Immich (http://immich.lan) is down: connection refused",
  });
  expect(work.requests).toHaveLength(1);

  // Limits saved before the reserve existed get it; one limit changes without the others.
  t.settings.update({ chatEffort: "medium" });
  t.db
    .query(
      "UPDATE settings SET value = json_remove(value, '$.limits.alertReserveUsd') WHERE key = 'app'",
    )
    .run();
  expect(t.settings.get().limits.alertReserveUsd).toBe(1);
  expect(t.settings.update({ limits: { alertReserveUsd: 0 } }).limits).toEqual({
    taskUsd: 3,
    researchUsd: 5,
    dailyUsd: 10,
    monthlyUsd: 200,
    alertReserveUsd: 0,
  });
});

test("a flapping monitor goes on its last task's timeline for an hour; a trigger starts 24 tasks a day at most", async () => {
  const done = {
    content: [toolUse("finish_task", { outcome: "done", summary: "Looked.", notify: false })],
  };
  const work = new FakeModel([done, done, done, done]);
  const t = await testApp(new FakeModel(), work);
  const triggerId = t.triggers.create({ name: "Kuma", kind: "kuma", prompt: "Fix it" }).id;
  const first = t.triggers.receiveKuma(triggerId, down);
  if (first.status !== "started") throw new Error(first.status);
  await waitFor(() => t.tasks.get(first.task.id)?.finishedAt);

  // Back up and down again ten minutes later: on that task's timeline, not a new task, and you're told.
  t.advance(10 * 60_000);
  expect(t.triggers.receiveKuma(triggerId, up)).toEqual({ status: "skipped", reason: "ignored" });
  expect(t.triggers.receiveKuma(triggerId, down)).toEqual({ status: "skipped", reason: "recent" });
  expect(t.tasks.steps(first.task.id).map((s) => s.name)).toEqual(
    expect.arrayContaining(["Jellyfin is back up", "Jellyfin is down again"]),
  );
  expect(t.tasks.list()).toHaveLength(1);
  const downAgain = () => t.notifier.sent.filter((n) => n.title === "Jellyfin is down again");
  expect(downAgain()).toEqual([
    expect.objectContaining({
      message: `It went down again after task #${first.task.id} ended. If it's still down in 50 minutes, a new task looks into it.`,
      click: expect.stringContaining(`/tasks/${first.task.id}`),
    }),
  ]);
  // Flapping more within the hour isn't told again.
  t.advance(60_000);
  t.triggers.receiveKuma(triggerId, up);
  t.triggers.receiveKuma(triggerId, down);
  expect(downAgain()).toHaveLength(1);
  // Kuma says nothing more while it stays down. An hour after the task ended, a new one.
  t.advance(40 * 60_000);
  t.triggers.tick();
  expect(t.tasks.list()).toHaveLength(1);
  t.advance(10 * 60_000);
  t.triggers.tick();
  const tasks = t.tasks.list();
  expect(tasks).toHaveLength(2);
  expect(tasks.find((x) => x.id !== first.task.id)).toMatchObject({ title: "Jellyfin is down" });
  await t.tasks.idle();

  // 22 more today, as if other monitors had gone down: the 24th is the last, and you're told.
  for (let i = 0; i < 21; i++)
    t.db
      .query(
        `INSERT INTO tasks (title, goal, success_criteria, origin, lane, model, status, budget_usd, created_at, finished_at, trigger_id, run_key)
         VALUES ('Other is down', 'g', '', 'alert', 'background', 'm', 'done', 1, ?, ?, ?, ?)`,
      )
      .run(
        new Date(Date.parse("2026-10-09T13:00:00Z")).toISOString(),
        "2026-10-09T13:00:00.000Z",
        triggerId,
        `kuma:${triggerId}:${100 + i}`,
      );
  const other = (id: number) => ({
    heartbeat: { status: 0, msg: "timeout" },
    monitor: { id, name: `Monitor ${id}` },
  });
  expect(t.triggers.receiveKuma(triggerId, other(7)).status).toBe("started");
  expect(t.notifier.sent.filter((n) => n.title === "Kuma is at its limit")).toHaveLength(1);
  expect(t.triggers.receiveKuma(triggerId, other(8))).toEqual({
    status: "skipped",
    reason: "limit",
  });
  expect(t.notifier.sent.filter((n) => n.title === "Kuma is at its limit")).toHaveLength(1);
  // A day later it starts tasks again.
  await t.tasks.idle();
  t.advance(24 * 3600_000);
  expect(t.triggers.receiveKuma(triggerId, other(8)).status).toBe("started");
  await t.tasks.idle();
});
