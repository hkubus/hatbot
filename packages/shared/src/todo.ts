// The to-do list: todo.md in memory, markdown checkboxes with optional tags (PLAN.md §19).
//   - [ ] Renew the OVH domain due:2026-10-25
//   - [ ] Call the plumber due:2026-10-21 14:00
//   - [x] Replace the UPS battery done:2026-10-18

import { z } from "zod";

export const TODO_FILE = "todo.md";

export type Todo = {
  /** Its line in the file, from 0. */
  line: number;
  done: boolean;
  /** What's to do, without its tags. */
  text: string;
  /** YYYY-MM-DD, the owner's local date. */
  due: string | null;
  /** HH:MM, for an item due at a time. */
  at: string | null;
  doneOn: string | null;
};

/** An item as the apps show it, with the task working on it if one is. */
export type TodoItem = Todo & { taskId: number | null };

/** The to-do view: open items, and those ticked off in the last week (GET /todo). */
export type TodoList = { items: TodoItem[] };

export const AddTodo = z.object({
  item: z.string().trim().min(1).max(300),
  /** "2026-10-25", or "2026-10-25 14:00". */
  due: z.string().max(20).optional(),
});

/** An item the apps show: its text, and its line when they read the list. */
export const PickTodo = z.object({
  text: z.string().min(1).max(1000),
  line: z.number().int().min(0).optional(),
});

const ITEM = /^\s*[-*]\s+\[([ xX])\]\s+(.*)$/;
const DUE = /(?:^|\s)due:(\d{4}-\d{2}-\d{2})(?:[ T]([01]\d:[0-5]\d|2[0-3]:[0-5]\d))?(?=\s|$)/;
const DONE = /(?:^|\s)done:(\d{4}-\d{2}-\d{2})(?=\s|$)/;

const oneLine = (s: string) => s.trim().replace(/\s+/g, " ");

export function parseTodos(md: string): Todo[] {
  const out: Todo[] = [];
  md.split("\n").forEach((l, line) => {
    const m = ITEM.exec(l);
    if (!m) return;
    const body = m[2] ?? "";
    const due = DUE.exec(body);
    const done = DONE.exec(body);
    out.push({
      line,
      done: m[1] !== " ",
      text: oneLine(body.replace(DUE, " ").replace(DONE, " ")),
      due: due?.[1] ?? null,
      at: due?.[2] ?? null,
      doneOn: done?.[1] ?? null,
    });
  });
  return out;
}

/** "due:2026-10-25", or "due:2026-10-25 14:00". */
export const dueTag = (date: string, at?: string | null) => `due:${date}${at ? ` ${at}` : ""}`;

/** "Renew the domain (due 2026-10-25)", as the model and reminders show an item. */
export const todoLine = (t: Todo) =>
  `${t.text}${t.due ? ` (due ${t.due}${t.at ? ` ${t.at}` : ""})` : ""}`;

/** The list with `item` added after its last item, or a new list. `item` may carry its own tags. */
export function withTodo(md: string, item: string): string {
  const line = `- [ ] ${oneLine(item)}`;
  if (!md.trim()) return `# To-do\n\n${line}\n`;
  const lines = md.replace(/\s+$/, "").split("\n");
  const last = lines.findLastIndex((l) => ITEM.test(l));
  if (last < 0) lines.push("", line);
  else lines.splice(last + 1, 0, line);
  return `${lines.join("\n")}\n`;
}

/** The open item `which` names: its whole text, or else the one whose text has it. A string says why not. */
export function findTodo(md: string, which: string): Todo | string {
  const want = oneLine(which).toLowerCase();
  const open = parseTodos(md).filter((t) => !t.done);
  const exact = open.filter((t) => t.text.toLowerCase() === want);
  const found = exact.length ? exact : open.filter((t) => t.text.toLowerCase().includes(want));
  if (found.length === 1) return found[0] as Todo;
  if (!found.length) return `No open to-do matches "${which}".`;
  return `"${which}" matches ${found.length} open to-dos: ${found.map((t) => `"${t.text}"`).join(", ")}. Say which.`;
}

/**
 * The open item with exactly this text: the one at `line` if it's still there, or else the only one.
 * Not part of a text, as findTodo allows: a button or a task names one item, and mustn't tick another.
 */
export function todoAt(md: string, text: string, line?: number): Todo | null {
  const same = parseTodos(md).filter((t) => !t.done && t.text === oneLine(text));
  return same.find((t) => t.line === line) ?? (same.length === 1 ? (same[0] as Todo) : null);
}

/** The list with `t` ticked off on `date`. */
export function withDone(md: string, t: Todo, date: string): string {
  const lines = md.split("\n");
  const l = lines[t.line] ?? "";
  lines[t.line] = `${l.replace(/\[ \]/, "[x]").replace(/\s+$/, "")} done:${date}`;
  return lines.join("\n");
}

/** "2026-10-18": `d`'s date in local time, the time zone due dates are in. */
export function localDay(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
