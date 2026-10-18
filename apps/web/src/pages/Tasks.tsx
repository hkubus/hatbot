import { latestNoteOnly, OPEN_NEGOTIATION_STATUSES, type Task } from "@hatbot/shared";
import { useEffect, useMemo, useState } from "react";
import { useAction } from "../action";
import { api } from "../api";
import { ask } from "../confirm";
import { NoForm } from "../form";
import { modelName, plainText, shortStamp, time, timeOrDay, usd } from "../format";
import { Icon } from "../icons";
import { Link } from "../link";
import { LiveView, StepIcon } from "../live";
import { LoadError, loadErrorText, useItem } from "../load";
import { NegotiationChip } from "../negotiations";
import { navigate } from "../router";
import {
  botName,
  cancelTask,
  chatName,
  chatPath,
  HATBOT_CHAT,
  loadNegotiations,
  loadTask,
  loadTasks,
  negotiationOf,
  useStore,
} from "../store";
import { ApprovalCard, isActive, Shot, StatusChip, taskLine } from "../tasks";
import { BackHead, Group, LinkRow, Seg } from "../ui";
import { AssistantBody } from "./Chat";

/** A page of finished tasks; the list pages back from the oldest shown. */
const TASK_PAGE = 50;

export function Tasks() {
  const [filter, setFilter] = useState<"active" | "done">("active");
  const [ids, setIds] = useState<number[] | null>(null);
  const [hasOlder, setHasOlder] = useState(false);
  const loadingOlder = useAction();
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
    await loadingOlder.run(
      async () => {
        const list = await loadTasks({ status: filter, before, limit: TASK_PAGE });
        setIds((s) => [...(s ?? []), ...list]);
        setHasOlder(list.length === TASK_PAGE);
      },
      (err) => setLoadError(loadErrorText(err)),
    );
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
          <Group title="Waiting for you">
            {request && (
              <LinkRow to={`/tasks/${request.taskId}?live=1`} label="Take over the desktop">
                <span className="val">{request.reason}</span>
              </LinkRow>
            )}
            {waiting.map((a) => {
              const n = a.kind === "mandate" ? negotiationOf({ negotiations }, a.id) : undefined;
              return (
                <LinkRow
                  key={a.id}
                  label={`Can I go ahead? ${a.summary}`}
                  to={
                    a.taskId
                      ? `/tasks/${a.taskId}`
                      : n
                        ? `/negotiations/${n.id}`
                        : a.conversationId && a.conversationId !== HATBOT_CHAT
                          ? `/chat/${a.conversationId}`
                          : "/"
                  }
                />
              );
            })}
          </Group>
        )}
        {talking.length > 0 && (
          <Group title="Negotiations">
            {talking.map((n) => (
              <LinkRow key={n.id} to={`/negotiations/${n.id}`} label={n.title}>
                <NegotiationChip status={n.status} />
              </LinkRow>
            ))}
          </Group>
        )}
        <div className="page-head">
          <Seg
            value={filter}
            options={[
              ["active", "Active"],
              ["done", "Finished"],
            ]}
            onChange={setFilter}
          />
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
                    <td className="muted">{timeOrDay(t.startedAt ?? t.createdAt)}</td>
                    <td className="num">{usd(t.costUsd)}</td>
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
            disabled={loadingOlder.busy}
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
export function From({ task }: { task: Task }) {
  // The chat it was started in, while it's still one of yours.
  const chat = useStore((s) => {
    const c = s.conversations.find((c) => c.id === task.conversationId);
    if (!c) return null;
    return c.kind === "group" ? chatName(s, c) : `Chat with ${botName(s, c.botIds[0])}`;
  });
  const go = (to: string, label: string) => (
    <button type="button" className="text-link" onClick={() => navigate(to)}>
      {label}
    </button>
  );
  if (task.parentId) return go(`/tasks/${task.parentId}`, `Task #${task.parentId}`);
  if (task.origin === "chat") {
    const id = task.conversationId;
    return chat && id ? go(chatPath(id), chat) : <>Chat</>;
  }
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
      <dd>{task.startedAt ? shortStamp(task.startedAt) : "–"}</dd>
      <dt>Model</dt>
      <dd>{modelName(task.model)}</dd>
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
      <dd className="tnum">{usd(task.costUsd)}</dd>
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
  const { missing, error: loadError, load } = useItem(id, loadTask);
  const { busy, error, run } = useAction();
  /** The goal being edited to run it again; null when that form is closed. */
  const [again, setAgain] = useState<string | null>(null);

  if (missing || !task)
    return (
      <NoForm
        error={loadError}
        missing={missing ? "This task doesn't exist." : ""}
        retry={load}
        back={{ label: "Tasks", to: "/tasks" }}
      />
    );

  const active = isActive(task);
  const pending = Object.values(approvals).filter((a) => a.taskId === id && a.status === "pending");
  // Open the live view when Hatbot asks you to take over.
  const screen = task.lane === "screen";
  const showLive = screen && active && (watch || request?.taskId === id);

  const cancel = async () => {
    if (!(await ask({ text: `Cancel "${task.title}"?`, ok: "Cancel task", cancel: "Keep it" })))
      return;
    await run(() => cancelTask(id));
  };

  const rerun = () =>
    run(async () => {
      const t = await api<Task>(`/tasks/${id}/rerun`, {
        body: { goal: again === task.goal ? undefined : again },
      });
      setAgain(null);
      navigate(`/tasks/${t.id}`);
    });

  return (
    <section className="view">
      <div className="page narrow">
        <BackHead to="/tasks" label="Tasks">
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
        </BackHead>
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
                    {s.kind === "note" && s.detail && (
                      <div className="muted">{plainText(s.detail)}</div>
                    )}
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
