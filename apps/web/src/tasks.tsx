// Task, approval and schedule cards, shared by the chat and the Tasks page.
import {
  API_PREFIX,
  type Approval,
  describeCron,
  type Schedule,
  type Task,
  type TaskStatus,
} from "@hatbot/shared";
import { useEffect, useState } from "react";
import { ApiError } from "./api";
import { Icon, type IconName } from "./icons";
import { navigate } from "./router";
import {
  decideApproval,
  ensureApproval,
  ensureSchedule,
  ensureTask,
  saveSchedule,
  useStore,
} from "./store";

const STATUS: Record<TaskStatus, [string, string]> = {
  queued: ["", "Queued"],
  running: ["brand", "Running"],
  waiting_approval: ["attn", "Needs approval"],
  waiting_takeover: ["attn", "Needs you"],
  done: ["ok", "Done"],
  failed: ["bad", "Failed"],
  cancelled: ["", "Cancelled"],
};

export function StatusChip({ status }: { status: TaskStatus }) {
  const [cls, label] = STATUS[status];
  return <span className={`chip ${cls}`}>{label}</span>;
}

export const isActive = (t: Task) => t.finishedAt === null;

export const screenUrl = (taskId: number, stepId: number) =>
  `${API_PREFIX}/tasks/${taskId}/screens/${stepId}`;

/** A screenshot from the archive; opens full size in a new tab. */
export function Shot({ taskId, stepId, alt }: { taskId: number; stepId: number; alt: string }) {
  const src = screenUrl(taskId, stepId);
  return (
    <a className="shot" href={src} target="_blank" rel="noreferrer">
      <img src={src} alt={alt} loading="lazy" />
    </a>
  );
}

/** The last line Hatbot wrote or thought, for a running task. */
const lastLine = (text?: string) => text?.trim().split("\n").filter(Boolean).at(-1);

export function taskLine(t: Task, progress?: string): string {
  if (t.summary && !isActive(t)) return t.summary;
  switch (t.status) {
    case "queued":
      return t.lane === "screen" ? "Waiting for the screen." : "Queued.";
    case "waiting_approval":
      return "Waiting for your approval.";
    case "waiting_takeover":
      return "Waiting for you to take over.";
    default:
      return lastLine(progress) ?? "Working…";
  }
}

/** What started a task, as an icon. */
export const taskIcon = (t: Task): IconName =>
  t.lane === "screen"
    ? "monitor"
    : t.origin === "schedule"
      ? "clock"
      : t.origin === "alert"
        ? "bell"
        : "zap";

export function TaskCard({ taskId }: { taskId: number }) {
  const task = useStore((s) => s.tasks[taskId]);
  const steps = useStore((s) => s.steps[taskId]);
  const progress = useStore((s) => s.taskProgress[taskId]);
  const control = useStore((s) => s.desktop?.control);
  useEffect(() => ensureTask(taskId), [taskId]);
  if (!task) return null;

  const shot = steps?.findLast((s) => s.screenshot);
  const active = isActive(task);
  const line =
    active && control === "owner" && task.status === "running"
      ? "Paused while you have control."
      : taskLine(task, progress);
  const bar = !active ? "done" : task.status.startsWith("waiting") ? "wait" : "";
  return (
    <div className="card task-card">
      <div className="card-head">
        <div
          className={`ico ${task.origin === "alert" && task.status !== "done" ? "bad" : "brand"}`}
        >
          <Icon name={taskIcon(task)} />
        </div>
        <div className="title">{task.title}</div>
        <div className="right">
          <StatusChip status={task.status} />
        </div>
      </div>
      <div className="card-body">
        <div className={shot ? "thumb-wrap" : ""}>
          <div className="task-line">
            <div>{line}</div>
            {task.status !== "cancelled" && task.status !== "failed" && (
              <div className={`progress ${bar}`} />
            )}
          </div>
          {shot && <Shot taskId={taskId} stepId={shot.id} alt={shot.name} />}
        </div>
      </div>
      <div className="card-foot">
        <span className="spacer" />
        <button type="button" className="btn sm ghost" onClick={() => navigate(`/tasks/${taskId}`)}>
          Details
          <Icon name="chevron" />
        </button>
      </div>
    </div>
  );
}

const RESOLVED: Record<Exclude<Approval["status"], "pending">, [string, string]> = {
  approved: ["ok", "Approved"],
  denied: ["bad", "Denied"],
  expired: ["", "Expired"],
  cancelled: ["", "Cancelled"],
};

export function ApprovalCard({
  approvalId,
  showDetails = true,
}: {
  approvalId: number;
  showDetails?: boolean;
}) {
  const a = useStore((s) => s.approvals[approvalId]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => ensureApproval(approvalId), [approvalId]);
  if (!a) return null;

  if (a.status !== "pending") {
    const [cls, label] = RESOLVED[a.status];
    return (
      <div className="resolved-line">
        <span className={`chip ${cls}`}>
          {a.status === "approved" && <Icon name="check" />}
          {a.status === "denied" && <Icon name="x" />}
          {label}
        </span>
        <span className="muted">{a.summary}</span>
      </div>
    );
  }

  const decide = async (decision: "approve" | "deny") => {
    setBusy(true);
    setError("");
    try {
      await decideApproval(a.id, decision);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't reach Hatbot.");
      setBusy(false);
    }
  };

  return (
    <div className="card attn">
      <div className="card-head">
        <div className="ico attn">
          <Icon name="shield" />
        </div>
        <div className="title">{a.summary}</div>
      </div>
      <div className="card-body">
        <div className={a.taskId && a.screenshotStepId ? "thumb-wrap" : ""}>
          <div className="approval-text">
            {a.reason && <p>{a.reason}</p>}
            {a.sources.length > 0 && <p className="muted">After reading {a.sources.join(", ")}</p>}
          </div>
          {a.taskId && a.screenshotStepId && (
            <Shot taskId={a.taskId} stepId={a.screenshotStepId} alt="The screen before this step" />
          )}
        </div>
        {error && <div className="form-error">{error}</div>}
      </div>
      <div className="card-foot">
        {showDetails && a.taskId && (
          <button
            type="button"
            className="btn sm ghost"
            onClick={() => navigate(`/tasks/${a.taskId}`)}
          >
            Details
          </button>
        )}
        <span className="spacer" />
        <button
          type="button"
          className="btn tint-danger"
          disabled={busy}
          onClick={() => decide("deny")}
        >
          Deny
        </button>
        <button
          type="button"
          className="btn primary"
          disabled={busy}
          onClick={() => decide("approve")}
        >
          <Icon name="check" />
          Approve
        </button>
      </div>
    </div>
  );
}

/** "Every day at 08:00", or "Once, Sat 11 Oct, 08:00". */
export function whenText(s: Pick<Schedule, "cron" | "runAt">): string {
  if (s.cron) return describeCron(s.cron);
  if (!s.runAt) return "";
  return `Once, ${new Date(s.runAt).toLocaleString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  })}`;
}

export function ScheduleCard({ scheduleId }: { scheduleId: number }) {
  const s = useStore((st) => st.schedules[scheduleId]);
  const [busy, setBusy] = useState(false);
  useEffect(() => ensureSchedule(scheduleId), [scheduleId]);
  if (s === undefined) return null;
  if (s === null)
    return (
      <div className="resolved-line">
        <span className="chip">Deleted</span>
        <span className="muted">A schedule</span>
      </div>
    );

  const toggle = async () => {
    setBusy(true);
    await saveSchedule(s.id, { enabled: !s.enabled }).catch(() => {});
    setBusy(false);
  };
  return (
    <div className="card">
      <div className="card-head">
        <div className="ico brand">
          <Icon name="clock" />
        </div>
        <div className="title">{s.name}</div>
        <div className="right">
          <button
            type="button"
            className={`switch ${s.enabled ? "on" : ""}`}
            aria-label={s.enabled ? "Turn off" : "Turn on"}
            aria-pressed={s.enabled}
            disabled={busy}
            onClick={toggle}
          />
        </div>
      </div>
      <div className="card-body">
        <dl className="kv">
          <dt>When</dt>
          <dd>{whenText(s)}</dd>
          <dt>Does</dt>
          <dd>{s.prompt}</dd>
        </dl>
      </div>
      <div className="card-foot">
        <span className="spacer" />
        <button
          type="button"
          className="btn sm ghost"
          onClick={() => navigate(`/schedules/${s.id}`)}
        >
          Details
          <Icon name="chevron" />
        </button>
      </div>
    </div>
  );
}
