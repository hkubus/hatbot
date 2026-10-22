import { localDay, type Task, type TodoItem, type TodoList } from "@hatbot/shared";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { useAction } from "../action";
import { api, errorText } from "../api";
import { Link } from "../link";
import { LoadError } from "../load";
import { useStore } from "../store";
import { isActive } from "../tasks";
import type { Toast } from "../toast";
import { Group } from "../ui";

/** "25 Oct", from a YYYY-MM-DD date in local time (a bare date would be read as UTC). */
const dayOf = (date: string) => {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
};

function Due({ item }: { item: TodoItem }) {
  if (!item.due) return null;
  const today = localDay(new Date());
  const at = item.at ? ` ${item.at}` : "";
  if (item.due < today) return <span className="val bad">Overdue, {dayOf(item.due)}</span>;
  return (
    <span className="val">{item.due === today ? `Today${at}` : `${dayOf(item.due)}${at}`}</span>
  );
}

export function TodoPage({ toast }: { toast: Toast }) {
  const [list, setList] = useState<TodoList | null>(null);
  const [loadError, setLoadError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [item, setItem] = useState("");
  const [due, setDue] = useState("");
  const { busy, error, run } = useAction();
  // Read again when memory changes, and when a task on an item starts or ends.
  const version = useStore((s) => s.memoryVersion);
  const working = useStore((s) =>
    Object.values(s.tasks)
      .filter((t) => t.todo && isActive(t))
      .map((t) => t.id)
      .join(","),
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: each is a reason to read it again
  useEffect(() => {
    let stale = false;
    setLoadError("");
    api<TodoList>("/todo").then(
      (l) => !stale && setList(l),
      (err) => !stale && setLoadError(errorText(err)),
    );
    return () => {
      stale = true;
    };
  }, [version, working, attempt]);

  const add = (e: FormEvent) => {
    e.preventDefault();
    run(async () => {
      setList(await api<TodoList>("/todo", { body: { item, due: due || undefined } }));
      setItem("");
      setDue("");
    });
  };
  const tick = useCallback(
    (t: TodoItem) =>
      api<TodoList>("/todo/done", { body: { text: t.text, line: t.line } }).then(setList, (err) =>
        toast(errorText(err, "Couldn't tick it off."), "error"),
      ),
    [toast],
  );
  const work = useCallback(
    (t: TodoItem) =>
      api<Task>("/todo/work", { body: { text: t.text, line: t.line } }).then(
        () => toast("Hatbot is on it"),
        (err) => toast(errorText(err, "Couldn't start it."), "error"),
      ),
    [toast],
  );

  if (!list)
    return (
      <section className="view">
        <div className="page narrow">
          {loadError && <LoadError error={loadError} retry={() => setAttempt((n) => n + 1)} />}
        </div>
      </section>
    );

  const open = list.items.filter((t) => !t.done);
  const done = list.items.filter((t) => t.done).reverse();
  return (
    <section className="view">
      <div className="page narrow">
        <form className="todo-add" onSubmit={add}>
          <input
            className="field"
            aria-label="New to-do"
            placeholder="Add a to-do"
            maxLength={300}
            value={item}
            onChange={(e) => setItem(e.target.value)}
          />
          <input
            className="field"
            type="date"
            aria-label="Due"
            value={due}
            onChange={(e) => setDue(e.target.value)}
          />
          <button type="submit" className="btn" disabled={busy || !item.trim()}>
            Add
          </button>
        </form>
        {error && <div className="form-error">{error}</div>}

        <Group>
          {open.map((t) => (
            <div className="row" key={`${t.line} ${t.text}`}>
              <input
                type="checkbox"
                className="todo-box"
                aria-label={`Done: ${t.text}`}
                checked={false}
                onChange={() => tick(t)}
              />
              <div className="txt">
                <b>{t.text}</b>
              </div>
              <Due item={t} />
              {t.taskId ? (
                <Link className="btn sm ghost" to={`/tasks/${t.taskId}`}>
                  Working on it
                </Link>
              ) : (
                <button type="button" className="btn sm" onClick={() => work(t)}>
                  Work on it
                </button>
              )}
            </div>
          ))}
          {!open.length && (
            <div className="row">
              <span className="muted">Nothing to do. Add one here, or ask Hatbot in the chat.</span>
            </div>
          )}
        </Group>

        {done.length > 0 && (
          <Group title="Done this week">
            {done.map((t) => (
              <div className="row" key={`${t.line} ${t.text}`}>
                <input type="checkbox" className="todo-box" aria-label="Done" checked disabled />
                <div className="txt">
                  <span>{t.text}</span>
                </div>
                {t.doneOn && <span className="val">{dayOf(t.doneOn)}</span>}
              </div>
            ))}
          </Group>
        )}
      </div>
    </section>
  );
}
