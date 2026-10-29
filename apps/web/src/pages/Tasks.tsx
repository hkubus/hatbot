import {
  isFullTask,
  latestNoteOnly,
  OPEN_NEGOTIATION_STATUSES,
  type Task,
  type TaskCard,
} from "@hatbot/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import { useAction } from "../action";
import { api } from "../api";
import { ask, useLeaveGuard } from "../confirm";
import { modelName, plainText, shortStamp, time, usd } from "../format";
import { Icon } from "../icons";
import { Link } from "../link";
import { LiveView, StepIcon } from "../live";
import { LoadError, PageLoad, useItem, useLoad } from "../load";
import { AssistantBody, isMarkdownFile } from "../markdown";
import { NegotiationChip } from "../negotiations";
import { navigate } from "../router";
import {
  botName,
  cancelTask,
  chatName,
  chatPath,
  loadNegotiations,
  loadTask,
  loadTasks,
  negotiationOf,
  useStore,
} from "../store";
import {
  ApprovalCard,
  isActive,
  PendingQuestion,
  Shot,
  StatusChip,
  TaskTable,
  taskLine,
} from "../tasks";
import { BackHead, Empty, Group, LinkRow, Seg } from "../ui";

const TASK_PAGE = 50;

export function Tasks() {
  const [filter, setFilter] = useState<"active" | "done">("active");
  const [hasOlder, setHasOlder] = useState(false);
  const loadingOlder = useAction();
  const tasks = useStore((s) => s.tasks);
  const approvals = useStore((s) => s.approvals);
  const questions = useStore((s) => s.questions);
  const request = useStore((s) => s.desktop?.request ?? null);
  const negotiations = useStore((s) => s.negotiations);
  const waiting = useMemo(
    () =>
      Object.values(approvals)
        .filter((a) => a.status === "pending")
        .sort((a, b) => a.id - b.id),
    [approvals],
  );
  const asked = Object.values(questions).filter((q) => q.status === "pending");
  const talking = useMemo(
    () =>
      Object.values(negotiations)
        .filter((n) => OPEN_NEGOTIATION_STATUSES.includes(n.status))
        .sort((a, b) => b.id - a.id),
    [negotiations],
  );
  useEffect(() => void loadNegotiations().catch(() => {}), []);

  const {
    data: ids,
    setData: setIds,
    ...load
  } = useLoad(
    () =>
      loadTasks({ status: filter, limit: TASK_PAGE }).then((list) => {
        setHasOlder(list.length === TASK_PAGE);
        return list;
      }),
    [filter],
  );
  const pick = (f: typeof filter) => {
    setIds(null);
    setHasOlder(false);
    setFilter(f);
  };

  const older = async () => {
    const before = ids?.length ? Math.min(...ids) : undefined;
    if (!before) return;
    await loadingOlder.run(async () => {
      const list = await loadTasks({ status: filter, before, limit: TASK_PAGE });
      setIds((s) => [...(s ?? []), ...list]);
      setHasOlder(list.length === TASK_PAGE);
    });
  };

  // Tasks that start or finish while the list is open move between the two lists.
  const shown = Object.values(tasks)
    .filter((t) => (filter === "active" ? isActive(t) : !isActive(t)))
    .filter((t) => filter === "active" || ids?.includes(t.id))
    .sort((a, b) => b.id - a.id);

  return (
    <section className="view">
      <div className="page">
        {(waiting.length > 0 || asked.length > 0 || request) && (
          <Group title="Waiting for you">
            {request && (
              <LinkRow to={`/tasks/${request.taskId}?live=1`} label="Take over the desktop">
                <span className="val">{request.reason}</span>
              </LinkRow>
            )}
            {asked.map((q) => (
              <LinkRow key={`q${q.id}`} label={q.question} to={`/tasks/${q.taskId}`} />
            ))}
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
                        : a.conversationId
                          ? chatPath(a.conversationId)
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
            onChange={pick}
          />
        </div>
        {load.error && <LoadError error={load.error} retry={load.retry} />}
        {ids && !shown.length && (
          <Empty>{filter === "active" ? "Nothing running." : "No tasks yet."}</Empty>
        )}
        {shown.length > 0 && <TaskTable tasks={shown} />}
        {loadingOlder.error && <LoadError error={loadingOlder.error} retry={older} />}
        {filter === "done" && hasOlder && !load.error && !loadingOlder.error && (
          <button
            type="button"
            className="btn sm ghost load-earlier"
            disabled={loadingOlder.busy}
            onClick={older}
          >
            Earlier
          </button>
        )}
      </div>
    </section>
  );
}

export function From({ task }: { task: TaskCard }) {
  // The chat it was started in, while it's still one of yours.
  const chat = useStore((s) => {
    const c = s.conversations.find((c) => c.id === task.conversationId);
    if (!c) return null;
    return c.kind === "group" ? chatName(s, c) : `Chat with ${botName(s, c.botIds[0])}`;
  });
  const go = (to: string, label: string) => (
    <Link className="text-link" to={to}>
      {label}
    </Link>
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

/** Where a research task's report opens: its note, or the copy attached to the task when that's gone. */
function reportLink(task: Task, file: { id: number; name: string } | undefined) {
  if (task.reportPath)
    return {
      to: `/read?path=${encodeURIComponent(task.reportPath)}${file ? `&file=${file.id}` : ""}`,
      label: task.reportPath,
    };
  return file ? { to: `/read?file=${file.id}`, label: file.name } : null;
}

function Details({ task }: { task: Task }) {
  const files = useStore((s) => s.taskFiles[task.id]);
  const report = task.research ? reportLink(task, files?.find(isMarkdownFile)) : null;
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
      <dd>{task.startedAt ? shortStamp(task.startedAt) : "Not yet"}</dd>
      <dt>Model</dt>
      <dd>{modelName(task.model)}</dd>
      <dt>Trust</dt>
      <dd>
        {task.tainted
          ? task.lane === "screen"
            ? "Read web pages"
            : "Read untrusted content"
          : "Trusted sources only"}
      </dd>
      {task.taintedBy && (
        <>
          <dt>Tainted by</dt>
          <dd>{task.taintedBy}</dd>
        </>
      )}
      <dt>Cost</dt>
      <dd className="tnum">{usd(task.costUsd)}</dd>
      {report && (
        <>
          <dt>Report</dt>
          <dd>
            <Link className="text-link" to={report.to}>
              {report.label}
            </Link>
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
  const questions = useStore((s) => s.questions);
  const [watch, setWatch] = useState(live);
  const { missing, error: loadError, load } = useItem(id, loadTask);
  const { busy, error, run } = useAction();
  /** The goal being edited to run it again; null when that form is closed. */
  const [again, setAgain] = useState<string | null>(null);
  const goal = task && isFullTask(task) ? task.goal : undefined;
  const release = useLeaveGuard(again !== null && again !== goal);
  // A research task attaches its report as it ends: fetched again then, to link it.
  const ended = !!task && !isActive(task);
  const wasRunning = useRef(false);
  useEffect(() => {
    if (!task?.research) return;
    if (!ended) wasRunning.current = true;
    else if (wasRunning.current) {
      wasRunning.current = false;
      void loadTask(id).catch(() => {});
    }
  }, [ended, task?.research, id]);

  if (missing || !task)
    return (
      <PageLoad
        error={loadError}
        missing={missing ? "This task doesn't exist." : ""}
        retry={load}
        back={{ label: "Tasks", to: "/tasks" }}
      />
    );

  const active = isActive(task);
  // A chat's card until the whole task comes: its details and goal only then.
  const full = isFullTask(task) ? task : null;
  const pending = Object.values(approvals).filter(
    (a) => a.taskId === id && (a.status === "pending" || a.status === "blocked"),
  );
  const asked = Object.values(questions).filter((q) => q.taskId === id && q.status === "pending");
  const screen = task.lane === "screen";
  const showLive = screen && active && (watch || request?.taskId === id);

  const cancel = async () => {
    if (!(await ask({ text: `Cancel ${task.title}?`, ok: "Cancel task", cancel: "Keep it" })))
      return;
    await run(() => cancelTask(id));
  };

  const rerun = () =>
    run(async () => {
      const t = await api<Task>(`/tasks/${id}/rerun`, {
        body: { goal: again === full?.goal ? undefined : again },
      });
      setAgain(null);
      release();
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
          {full && !active && !task.parentId && !screen && again === null && (
            <button type="button" className="btn sm" onClick={() => setAgain(full.goal)}>
              <Icon name="retry" />
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
        {asked.map((q) => (
          <div key={q.id} className="card attn">
            <PendingQuestion q={q} />
          </div>
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
          {full && <Details task={full} />}
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
                      <Link className="text-link" to={s.url as string}>
                        {s.name}
                      </Link>
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
