import type { Task } from "@hatbot/shared";
import { useEffect, useState } from "react";
import { ApiError } from "../api";
import { Icon } from "../icons";
import { LiveView, StepIcon } from "../live";
import { navigate } from "../router";
import { cancelTask, loadTask, loadTasks, useStore } from "../store";
import { ApprovalCard, isActive, Shot, StatusChip, taskLine } from "../tasks";

const money = (usd: number) => `$${usd.toFixed(2)}`;
const time = (iso: string) =>
  new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
function when(iso: string) {
  const d = new Date(iso);
  if (d.toDateString() === new Date().toDateString()) return time(iso);
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

const stamp = (iso: string) =>
  new Date(iso).toDateString() === new Date().toDateString()
    ? time(iso)
    : `${when(iso)}, ${time(iso)}`;

export function Tasks() {
  const [filter, setFilter] = useState<"active" | "done">("active");
  const [ids, setIds] = useState<number[] | null>(null);
  const tasks = useStore((s) => s.tasks);

  useEffect(() => {
    setIds(null);
    loadTasks({ status: filter }).then(setIds, () => setIds([]));
  }, [filter]);

  // Tasks that start or finish while the list is open move between the two lists.
  const shown = Object.values(tasks)
    .filter((t) => (filter === "active" ? isActive(t) : !isActive(t)))
    .filter((t) => filter === "active" || ids?.includes(t.id))
    .sort((a, b) => b.id - a.id);

  return (
    <section className="view">
      <div className="page">
        <div className="page-head">
          <div className="seg">
            <button
              type="button"
              className={filter === "active" ? "active" : ""}
              onClick={() => setFilter("active")}
            >
              Active
            </button>
            <button
              type="button"
              className={filter === "done" ? "active" : ""}
              onClick={() => setFilter("done")}
            >
              Finished
            </button>
          </div>
        </div>
        {ids && !shown.length && (
          <div className="empty">{filter === "active" ? "Nothing running." : "No tasks yet."}</div>
        )}
        {shown.length > 0 && (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Task</th>
                  <th>Status</th>
                  <th>Started</th>
                  <th className="num">Cost</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((t) => (
                  <tr key={t.id} onClick={() => navigate(`/tasks/${t.id}`)}>
                    <td className="wrap">
                      <span className="task-title">{t.title}</span>
                    </td>
                    <td>
                      <StatusChip status={t.status} />
                    </td>
                    <td className="muted">{when(t.startedAt ?? t.createdAt)}</td>
                    <td className="num">{money(t.costUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}

/** Where a task came from, linked. */
function From({ task }: { task: Task }) {
  const go = (to: string, label: string) => (
    <button type="button" className="text-link" onClick={() => navigate(to)}>
      {label}
    </button>
  );
  if (task.parentId) return go(`/tasks/${task.parentId}`, `Task #${task.parentId}`);
  if (task.origin === "chat") return <>Chat</>;
  const name = task.source ?? "";
  if (task.origin === "schedule")
    return task.scheduleId ? go(`/schedules/${task.scheduleId}`, name) : name;
  return task.triggerId ? go(`/triggers/${task.triggerId}`, name) : name;
}

function Details({ task }: { task: Task }) {
  return (
    <dl className="kv">
      <dt>From</dt>
      <dd>
        <From task={task} />
      </dd>
      <dt>Goal</dt>
      <dd>{task.goal}</dd>
      {task.successCriteria && (
        <>
          <dt>Done when</dt>
          <dd>{task.successCriteria}</dd>
        </>
      )}
      <dt>Started</dt>
      <dd>{task.startedAt ? stamp(task.startedAt) : "–"}</dd>
      <dt>Model</dt>
      <dd>{task.model}</dd>
      <dt>Trust</dt>
      <dd>
        {task.injectionSuspected ? (
          <span className="chip warn">
            <Icon name="alert" />
            Possible prompt injection
          </span>
        ) : task.tainted ? (
          task.lane === "screen" ? (
            "Read web pages"
          ) : (
            "Read untrusted content"
          )
        ) : (
          "Trusted sources only"
        )}
      </dd>
      <dt>Cost</dt>
      <dd className="tnum">{money(task.costUsd)}</dd>
      {task.payload && (
        <>
          <dt>Event</dt>
          <dd>
            <pre className="payload">{task.payload}</pre>
          </dd>
        </>
      )}
    </dl>
  );
}

export function TaskDetail({ id, live }: { id: number; live: boolean }) {
  const task = useStore((s) => s.tasks[id]);
  const steps = useStore((s) => s.steps[id]);
  const progress = useStore((s) => s.taskProgress[id]);
  const request = useStore((s) => s.desktop?.request);
  const approvals = useStore((s) => s.approvals);
  const [watch, setWatch] = useState(live);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    loadTask(id).catch(() => setMissing(true));
  }, [id]);

  if (missing) return <div className="empty">This task doesn't exist.</div>;
  if (!task) return <section className="view" />;

  const active = isActive(task);
  const pending = Object.values(approvals).filter((a) => a.taskId === id && a.status === "pending");
  // Open the live view when Hatbot asks you to take over.
  const screen = task.lane === "screen";
  const showLive = screen && active && (watch || request?.taskId === id);

  const cancel = async () => {
    if (!confirm(`Cancel "${task.title}"?`)) return;
    try {
      await cancelTask(id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't reach Hatbot.");
    }
  };

  return (
    <section className="view">
      <div className="page narrow">
        <div className="page-head">
          <button type="button" className="btn sm ghost back" onClick={() => navigate("/tasks")}>
            <Icon name="chevron" />
            Tasks
          </button>
          <span className="spacer" />
          {screen && active && !showLive && (
            <button type="button" className="btn sm" onClick={() => setWatch(true)}>
              <Icon name="monitor" />
              Watch
            </button>
          )}
          {active && (
            <button type="button" className="btn sm danger-text" onClick={cancel}>
              Cancel task
            </button>
          )}
        </div>
        {error && <div className="form-error">{error}</div>}

        {pending.map((a) => (
          <ApprovalCard key={a.id} approvalId={a.id} showDetails={false} />
        ))}
        {showLive && <LiveView taskId={id} />}

        <div className="panel">
          <div className="task-head">
            <h2>{task.title}</h2>
            <StatusChip status={task.status} />
          </div>
          <p className="task-summary">{taskLine(task, progress)}</p>
          <Details task={task} />
        </div>

        <div className="panel">
          <h3 className="section-title">Timeline</h3>
          {!steps?.length ? (
            <div className="muted">{active ? "Hasn't started yet." : "No steps."}</div>
          ) : (
            <ol className="timeline">
              {steps.map((s) => (
                <li key={s.id} className={`tl-step tl-${s.kind}`}>
                  <span className="t">{time(s.createdAt)}</span>
                  <StepIcon kind={s.kind} name={s.name} />
                  <div className="tl-text">
                    {s.kind === "task" && s.url ? (
                      <button
                        type="button"
                        className="text-link"
                        onClick={() => navigate(s.url as string)}
                      >
                        {s.name}
                      </button>
                    ) : (
                      <div>{s.detail && s.kind !== "note" ? s.detail : s.name}</div>
                    )}
                    {s.kind === "note" && s.detail && <div className="muted">{s.detail}</div>}
                    {s.screenshot && <Shot taskId={id} stepId={s.id} alt={s.name} />}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </section>
  );
}
