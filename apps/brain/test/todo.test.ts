import { expect, test } from "bun:test";
import { FakeModel, text, toolUse } from "./fake-model";
import { type TestApp, testApp } from "./helpers";

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
