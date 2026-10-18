import { expect, test } from "bun:test";
import type { Approval, Commit, Task } from "@hatbot/shared";
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
