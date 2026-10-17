import { latestNoteOnly, OPEN_NEGOTIATION_STATUSES, type Task } from "@hatbot/shared";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiError, api } from "../api";
import { ask } from "../confirm";
import { Icon } from "../icons";
import { Link } from "../link";
import { LiveView, StepIcon } from "../live";
import { LoadError, loadErrorText } from "../load";
import { NegotiationChip } from "../negotiations";
import { navigate } from "../router";
import {
  cancelTask,
  HATBOT_CHAT,
  loadNegotiations,
  loadTask,
  loadTasks,
  negotiationOf,
  useStore,
} from "../store";
import { ApprovalCard, isActive, Shot, StatusChip, taskLine } from "../tasks";
import { AssistantBody } from "./Chat";

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

/** A page of finished tasks; the list pages back from the oldest shown. */
const TASK_PAGE = 50;

export function Tasks() {
  const [filter, setFilter] = useState<"active" | "done">("active");
  const [ids, setIds] = useState<number[] | null>(null);
  const [hasOlder, setHasOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const tasks = useStore((s) => s.tasks);
  const approvals = useStore((s) => s.approvals);
  const request = useStore((s) => s.desktop?.request ?? null);
  const negotiations = useStore((s) => s.negotiations);
  const waiting = useMemo(
    () =>
      Object.values(approvals)
        .filter((a) => a.status === "pending")
        .sort((a, b) => a.id - b.id),
    [approvals],
  );
  const talking = useMemo(
    () =>
      Object.values(negotiations)
        .filter((n) => OPEN_NEGOTIATION_STATUSES.includes(n.status))
        .sort((a, b) => b.id - a.id),
    [negotiations],
  );
  useEffect(() => void loadNegotiations().catch(() => {}), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry loads again
  useEffect(() => {
    setIds(null);
    setHasOlder(false);
    setLoadError("");
    loadTasks({ status: filter, limit: TASK_PAGE }).then(
      (list) => {
        setIds(list);
        setHasOlder(list.length === TASK_PAGE);
      },
      (err) => setLoadError(loadErrorText(err)),
    );
  }, [filter, attempt]);

  const older = async () => {
    const before = ids?.length ? Math.min(...ids) : undefined;
    if (!before) return;
    setLoadingOlder(true);
    try {
      const list = await loadTasks({ status: filter, before, limit: TASK_PAGE });
      setIds((s) => [...(s ?? []), ...list]);
      setHasOlder(list.length === TASK_PAGE);
    } catch (err) {
      setLoadError(loadErrorText(err));
    }
    setLoadingOlder(false);
  };

  // Tasks that start or finish while the list is open move between the two lists.
  const shown = Object.values(tasks)
    .filter((t) => (filter === "active" ? isActive(t) : !isActive(t)))
    .filter((t) => filter === "active" || ids?.includes(t.id))
    .sort((a, b) => b.id - a.id);

  return (
    <section className="view">
      <div className="page">
        {(waiting.length > 0 || request) && (
          <section className="group">
            <h2>Waiting for you</h2>
            <div className="group-box">
              {request && (
                <Link className="row row-link" to={`/tasks/${request.taskId}?live=1`}>
                  <div className="txt">
                    <b>Take over the desktop</b>
                  </div>
                  <span className="val">{request.reason}</span>
                </Link>
              )}
              {waiting.map((a) => {
                const n = a.kind === "mandate" ? negotiationOf({ negotiations }, a.id) : undefined;
                return (
                  <Link
                    key={a.id}
                    className="row row-link"
                    to={
                      a.taskId
                        ? `/tasks/${a.taskId}`
                        : n
                          ? `/negotiations/${n.id}`
                          : a.conversationId && a.conversationId !== HATBOT_CHAT
                            ? `/chat/${a.conversationId}`
                            : "/"
                    }
                  >
                    <div className="txt">
                      <b>Can I go ahead? {a.summary}</b>
                    </div>
                    <Icon name="chevron" />
                  </Link>
                );
              })}
            </div>
          </section>
        )}
        {talking.length > 0 && (
          <section className="group">
            <h2>Negotiations</h2>
            <div className="group-box">
              {talking.map((n) => (
                <Link key={n.id} className="row row-link" to={`/negotiations/${n.id}`}>
                  <div className="txt">
                    <b>{n.title}</b>
                  </div>
                  <NegotiationChip status={n.status} />
                  <Icon name="chevron" />
                </Link>
              ))}
            </div>
          </section>
        )}
        <div className="page-head">
          <div className="seg">
            <button
              type="button"
              className={filter === "active" ? "active" : ""}
              aria-pressed={filter === "active"}
              onClick={() => setFilter("active")}
            >
              Active
            </button>
            <button
              type="button"
              className={filter === "done" ? "active" : ""}
              aria-pressed={filter === "done"}
              onClick={() => setFilter("done")}
            >
              Finished
            </button>
          </div>
        </div>
        {loadError && <LoadError error={loadError} retry={() => setAttempt((n) => n + 1)} />}
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
                  <tr key={t.id} className="link-row">
                    <td className="wrap">
                      {/* The link covers the whole row. */}
                      <Link className="task-title" to={`/tasks/${t.id}`}>
                        {t.title}
                      </Link>
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
        {filter === "done" && hasOlder && !loadError && (
          <button
            type="button"
            className="btn sm ghost load-earlier"
            disabled={loadingOlder}
            onClick={older}
          >
            Older
          </button>
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
  if (task.origin === "watch")
    return task.watcherId ? go(`/watchers/${task.watcherId}`, name) : name;
  if (task.origin === "heartbeat") return <>Heartbeat</>;
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
      {task.taintedBy && (
        <>
          <dt>Tainted by</dt>
          <dd>{task.taintedBy}</dd>
        </>
      )}
      <dt>Cost</dt>
      <dd className="tnum">{money(task.costUsd)}</dd>
      {task.reportPath && (
        <>
          <dt>Report</dt>
          <dd>
            <button
              type="button"
              className="text-link"
              onClick={() => navigate(`/memory?path=${encodeURIComponent(task.reportPath ?? "")}`)}
            >
              {task.reportPath}
            </button>
          </dd>
        </>
      )}
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
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  /** The goal being edited to run it again; null when that form is closed. */
  const [again, setAgain] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setLoadError("");
    loadTask(id).catch((err) => {
      if (err instanceof ApiError && err.status === 404) setMissing(true);
      else setLoadError(loadErrorText(err));
    });
  }, [id]);
  useEffect(load, [load]);

  if (missing) return <div className="empty">This task doesn't exist.</div>;
  if (!task)
    return (
      <section className="view">
        {loadError && (
          <div className="page narrow">
            <LoadError error={loadError} retry={load} />
          </div>
        )}
      </section>
    );

  const active = isActive(task);
  const pending = Object.values(approvals).filter((a) => a.taskId === id && a.status === "pending");
  // Open the live view when Hatbot asks you to take over.
  const screen = task.lane === "screen";
  const showLive = screen && active && (watch || request?.taskId === id);

  const cancel = async () => {
    if (!(await ask({ text: `Cancel "${task.title}"?`, ok: "Cancel task", cancel: "Keep it" })))
      return;
    try {
      await cancelTask(id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't reach Hatbot.");
    }
  };

  const rerun = async () => {
    setBusy(true);
    setError("");
    try {
      const t = await api<Task>(`/tasks/${id}/rerun`, {
        body: { goal: again === task.goal ? undefined : again },
      });
      setAgain(null);
      navigate(`/tasks/${t.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't reach Hatbot.");
    }
    setBusy(false);
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
          {!active && !task.parentId && !screen && again === null && (
            <button type="button" className="btn sm" onClick={() => setAgain(task.goal)}>
              <Icon name="undo" />
              Run again
            </button>
          )}
        </div>
        {error && <div className="form-error">{error}</div>}
        {again !== null && (
          <div className="panel form">
            <label>
              <span className="label">What to do</span>
              <textarea
                className="field"
                rows={5}
                maxLength={8000}
                value={again}
                onChange={(e) => setAgain(e.target.value)}
              />
            </label>
            <div className="form-actions">
              <button type="button" className="btn ghost" onClick={() => setAgain(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn accent"
                disabled={busy || !again.trim()}
                onClick={rerun}
              >
                Run
              </button>
            </div>
          </div>
        )}

        {pending.map((a) => (
          <ApprovalCard key={a.id} approvalId={a.id} showDetails={false} />
        ))}
        {showLive && <LiveView taskId={id} />}

        <div className="panel">
          <div className="task-head">
            <h2>{task.title}</h2>
            <StatusChip status={task.status} />
          </div>
          {!active && task.summary ? (
            <div className="task-summary">
              <AssistantBody text={task.summary} />
            </div>
          ) : (
            <p className="task-summary">{taskLine(task, progress)}</p>
          )}
          <Details task={task} />
        </div>

        <div className="panel">
          <h3 className="section-title">Timeline</h3>
          {!steps?.length ? (
            <div className="muted">{active ? "Hasn't started yet." : "No steps."}</div>
          ) : (
            <ol className="timeline">
              {latestNoteOnly(steps).map((s) => (
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
