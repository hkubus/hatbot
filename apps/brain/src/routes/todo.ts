// The to-do list in the apps (PLAN.md §19): its items, with checkboxes and a task to work on one.
import {
  AddTodo,
  localDay,
  PickTodo,
  parseTodos,
  TODO_FILE,
  type TodoList,
  todoAt,
  withTodo,
} from "@hatbot/shared";
import { type Context, Hono } from "hono";
import { dueInput, tickTodo } from "../agent/tools";
import { requireAuth } from "../auth/middleware";
import type { AppEnv } from "../context";
import { json } from "./util";

/** Ticked-off items stay in the view this long. */
const DONE_SHOWN_MS = 7 * 86400_000;
const GONE = "That to-do isn't open any more.";

/** Open items, and those ticked off this last week, each with the task working on it. */
async function list(c: Context<AppEnv>): Promise<TodoList> {
  const { memory, tasks } = c.var;
  const since = localDay(new Date(tasks.clock() - DONE_SHOWN_MS));
  const working = tasks.onTodos();
  const items = parseTodos((await memory.readOrNull(TODO_FILE)) ?? "")
    .filter((t) => !t.done || (t.doneOn ?? "") >= since)
    .map((t) => ({ ...t, taskId: t.done ? null : (working.get(t.text) ?? null) }));
  return { items };
}

export const todoRoutes = new Hono<AppEnv>()
  .use("/todo", requireAuth)
  .use("/todo/*", requireAuth)
  .get("/todo", async (c) => c.json(await list(c)))
  .post("/todo", json(AddTodo), async (c) => {
    const { memory, settings } = c.var;
    const { item, due } = c.req.valid("json");
    const line = due?.trim() ? `${item} ${dueInput(due.trim())}` : item;
    await memory.update(
      TODO_FILE,
      (md) => withTodo(md ?? "", line),
      settings.get().owner,
      `To-do: ${item.slice(0, 60)}`,
    );
    return c.json(await list(c), 201);
  })
  // A checkbox: ticked off as todo_done does, by you.
  .post("/todo/done", json(PickTodo), async (c) => {
    const { db, memory, events, settings, tasks } = c.var;
    const { text, line } = c.req.valid("json");
    await tickTodo(
      { db, memory, events, clock: tasks.clock },
      text,
      (md) => todoAt(md, text, line) ?? GONE,
      settings.get().owner,
    );
    return c.json(await list(c));
  })
  // A task on the item, in Hatbot's chat; it ticks the item off when it ends done.
  .post("/todo/work", json(PickTodo), async (c) => {
    const { memory, settings, tasks } = c.var;
    const { text, line } = c.req.valid("json");
    if (settings.get().paused) return c.json({ error: "Hatbot is paused." }, 409);
    const t = todoAt((await memory.readOrNull(TODO_FILE)) ?? "", text, line);
    if (!t) return c.json({ error: GONE }, 404);
    const task = tasks.createBackgroundTask({
      title: t.text.length > 80 ? `${t.text.slice(0, 79)}…` : t.text,
      goal: t.text,
      todo: t.text,
      origin: "chat",
      // What the approval check reads as your request: the item, on a list untrusted content can't change.
      request: t.text,
    });
    if (!task) return c.json({ error: "A task is already working on it." }, 409);
    return c.json(task, 201);
  });
