import { expect, test } from "bun:test";
import type { Task, TodoList } from "@hatbot/shared";
import { FakeModel, text, toolUse } from "./fake-model";
import { signIn, type TestApp, testApp } from "./helpers";

/** Moves the clock to that local time. */
const at = (t: TestApp, y: number, m: number, d: number, h: number, min = 0) =>
  t.advance(new Date(y, m - 1, d, h, min).getTime() - t.clock());
const reminders = (t: TestApp) =>
  t.notifier.sent.filter((n) => n.title === "To-do").map((n) => n.message);

test("the to-do list: added and ticked off in the chat, shown to the next conversation, and reminded", async () => {
  const model = new FakeModel([
    {
      content: [
        toolUse("todo_add", { item: "Renew the domain", due: "2026-10-09" }),
        toolUse("todo_add", { item: "Call the plumber", due: "2026-10-10 10:00" }),
        toolUse("todo_add", { item: "Fix the gate", due: "2026-02-30" }),
      ],
    },
    { content: [text("Added.")] },
    { content: [toolUse("todo_done", { item: "plumber" })] },
    { content: [text("Done.")] },
    { content: [text("Two things.")] },
  ]);
  const t = await testApp(model);
  at(t, 2026, 10, 10, 8);
  await t.thread.post("renew the domain by the 9th, call the plumber tomorrow at 10").done;
  await t.thread.post("/todo Buy filters").done;
  const results = JSON.stringify(model.requests[1]?.messages);
  expect(results).toContain("isn't a date");

  // A morning list once a day, from 9; an item due at a time, at that time, once.
  await t.todoReminders.tick();
  expect(reminders(t)).toEqual([]);
  at(t, 2026, 10, 10, 9, 5);
  await t.todoReminders.tick();
  await t.todoReminders.tick();
  expect(reminders(t)).toEqual([
    "Due today:\n- Call the plumber (due 2026-10-10 10:00)\nOverdue:\n- Renew the domain (due 2026-10-09)",
  ]);
  at(t, 2026, 10, 10, 10, 1);
  await t.todoReminders.tick();
  await t.todoReminders.tick();
  expect(reminders(t).slice(1)).toEqual(["Call the plumber"]);

  await t.thread.post("I called the plumber").done;
  expect(await t.memory.read("todo.md")).toBe(
    "# To-do\n\n- [ ] Renew the domain due:2026-10-09\n- [x] Call the plumber due:2026-10-10 10:00 done:2026-10-10\n- [ ] Buy filters\n",
  );
  await t.thread.post("/new").done;
  await t.thread.post("what's left?").done;
  const opening = JSON.stringify(model.requests.at(-1)?.messages);
  expect(opening).toContain("- Renew the domain (due 2026-10-09)\\n- Buy filters\\n</todo>");

  // The morning list goes out at the hour set.
  t.settings.update({ todoHour: 10 });
  at(t, 2026, 10, 11, 9, 5);
  await t.todoReminders.tick();
  expect(reminders(t)).toHaveLength(2);
  at(t, 2026, 10, 11, 10);
  await t.todoReminders.tick();
  expect(reminders(t).slice(2)).toEqual(["Overdue:\n- Renew the domain (due 2026-10-09)"]);
  expect((await t.report.make()).text).toContain("- To-do: 1 done, 1 overdue.");
});

test("in the apps: an item is added, ticked off, and ticked off by a task on it only when that ends done", async () => {
  const end = (outcome: string) => ({
    content: [toolUse("finish_task", { outcome, summary: outcome, notify: false })],
  });
  const t = await testApp(new FakeModel(), new FakeModel([end("failed"), end("done")]));
  const auth = signIn(t);
  const call = (path: string, body?: unknown) => t.call("POST", path, body, auth);
  expect((await call("/todo", { item: "Fix the gate" })).status).toBe(201);
  const added = await call("/todo", { item: "Buy filters", due: "2026-10-12" });
  const { items } = (await added.json()) as TodoList;
  expect(items.map((i) => [i.text, i.due])).toEqual([
    ["Fix the gate", null],
    ["Buy filters", "2026-10-12"],
  ]);

  // One task on an item at a time; one that fails leaves it open.
  const work = { text: "Fix the gate", line: items[0]?.line };
  const failed = (await (await call("/todo/work", work)).json()) as Task;
  expect((await call("/todo/work", work)).status).toBe(409);
  await t.tasks.idle();
  expect(t.tasks.get(failed.id)?.status).toBe("failed");
  expect(await t.memory.read("todo.md")).toContain("- [ ] Fix the gate\n");
  await call("/todo/work", work);
  await t.tasks.idle();

  await call("/todo/done", { text: "Buy filters", line: items[1]?.line });
  expect(await t.memory.read("todo.md")).toBe(
    "# To-do\n\n- [x] Fix the gate done:2026-10-09\n- [x] Buy filters due:2026-10-12 done:2026-10-09\n",
  );
});
