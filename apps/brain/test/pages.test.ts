import { expect, test } from "bun:test";
import type { Approval, Commit, SpendByPurpose, Task } from "@hatbot/shared";
import { HATBOT } from "../src/memory/store";
import { setUpOwner, testApp } from "./helpers";

test("tasks, approvals and memory history come a page at a time", async () => {
  const t = await testApp();
  const { cookie } = await setUpOwner(t);
  const get = async <T>(path: string) =>
    (await (await t.call("GET", path, undefined, { cookie })).json()) as T;
  const now = "2026-10-09T12:00:00.000Z";
  for (let i = 1; i <= 7; i++)
    t.db
      .query(
        `INSERT INTO tasks (title, goal, success_criteria, origin, lane, model, status, budget_usd, created_at, bot_id)
         VALUES (?, 'g', '', ?, 'background', 'm', 'done', 1, ?, ?)`,
      )
      .run(`t${i}`, i % 2 ? "chat" : "schedule", now, i === 7 ? "chef" : "hatbot");

  const first = await get<Task[]>("/tasks?limit=3");
  expect(first.map((x) => x.id)).toEqual([7, 6, 5]);
  const next = await get<Task[]>(`/tasks?limit=3&before=${first.at(-1)?.id}`);
  expect(next.map((x) => x.id)).toEqual([4, 3, 2]);
  expect((await get<Task[]>("/tasks?limit=3&before=2")).map((x) => x.id)).toEqual([1]);
  expect((await get<Task[]>("/tasks?origin=schedule")).map((x) => x.id)).toEqual([6, 4, 2]);
  expect((await get<Task[]>("/tasks?botId=chef")).map((x) => x.id)).toEqual([7]);
  expect((await t.call("GET", "/tasks?limit=500", undefined, { cookie })).status).toBe(400);
  // Search finds them in one query.
  expect(t.tasks.list({ like: "%t1%" }).map((x) => x.id)).toEqual([1]);

  // A step is looked up by its id and its task's.
  t.db
    .query(
      "INSERT INTO task_steps (task_id, kind, name, detail, created_at) VALUES (2, 'note', 'n', '', ?)",
    )
    .run(now);
  expect(t.tasks.step(2, 1)).toMatchObject({ id: 1, taskId: 2, name: "n" });
  expect(t.tasks.step(3, 1)).toBeNull();

  for (let i = 0; i < 3; i++)
    t.db
      .query(
        `INSERT INTO approvals (kind, summary, reason, sources, status, created_at, expires_at)
         VALUES ('k', ?, 'r', '[]', 'denied', ?, ?)`,
      )
      .run(`a${i}`, now, now);
  expect((await get<Approval[]>("/approvals?before=3")).map((a) => a.id)).toEqual([2, 1]);

  for (const n of [1, 2, 3]) await t.memory.write(`n${n}.md`, `${n}`, HATBOT, `Note ${n}`);
  const log = await get<Commit[]>("/memory/log?limit=2&skip=1");
  expect(log.map((c) => c.message)).toEqual(["Note 2", "Note 1"]);
});

test("spend by purpose, the most first", async () => {
  const t = await testApp();
  const { cookie } = await setUpOwner(t);
  const usage = { input_tokens: 1000, output_tokens: 100 };
  t.spend.record({ model: "claude-haiku-5-5", purpose: "thread", usage });
  t.spend.record({ model: "claude-opus-5-5", purpose: "tidy", usage });
  t.spend.record({ model: "claude-haiku-5-5", purpose: "thread", usage });
  const res = await t.call("GET", "/spend/by-purpose?days=30", undefined, { cookie });
  const rows = (await res.json()) as SpendByPurpose[];
  expect(rows.map((r) => r.purpose)).toEqual(["tidy", "thread"]);
  expect(rows[0]?.costUsd).toBeGreaterThan(0);
});
