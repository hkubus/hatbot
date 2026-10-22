import {
  API_PREFIX,
  type Approval,
  type ApprovalScope,
  describeCron,
  type Question,
  type Schedule,
  type TaskCard,
  type TaskStatus,
} from "@hatbot/shared";
import { useEffect, useState } from "react";
import { errorText } from "./api";
import { plainText, stamp, timeOrDay, usd } from "./format";
import { Icon } from "./icons";
import { Link } from "./link";
import {
  answerQuestion,
  decideApproval,
  ensureApproval,
  ensureSchedule,
  ensureTask,
  ensureWatcher,
  trustConversation,
  trustSchedule,
  trustWatcher,
  useStore,
} from "./store";

const STATUS: Record<TaskStatus, [string, string]> = {
  queued: ["", "Queued"],
  running: ["brand", "Running"],
  waiting_approval: ["attn", "Needs approval"],
  waiting_takeover: ["attn", "Needs you"],
  waiting_answer: ["attn", "Asks you"],
  done: ["ok", "Done"],
  failed: ["bad", "Failed"],
  cancelled: ["", "Cancelled"],
};

/** A list of tasks; `name` is what each is called, its title unless said otherwise. */
export function TaskTable({
  tasks,
  name = (t) => t.title,
}: {
  tasks: TaskCard[];
  name?: (t: TaskCard) => string;
}) {
  return (
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
          {tasks.map((t) => (
            <tr key={t.id} className="link-row">
              <td className="wrap">
                <Link className="task-title" to={`/tasks/${t.id}`}>
                  {name(t)}
                </Link>
              </td>
              <td>
                <StatusChip status={t.status} />
              </td>
              <td className="muted">{timeOrDay(t.startedAt ?? t.createdAt)}</td>
              <td className="num">{"costUsd" in t ? usd(t.costUsd as number) : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Plain coloured text; a chip only for what waits on you. */
export function StatusChip({ status }: { status: TaskStatus }) {
  const [cls, label] = STATUS[status];
  return <span className={cls === "attn" ? "chip attn" : `status ${cls}`}>{label}</span>;
}

export const isActive = (t: TaskCard) => t.finishedAt === null;

export const screenUrl = (taskId: number, stepId: number) =>
  `${API_PREFIX}/tasks/${taskId}/screens/${stepId}`;

export function Shot({ taskId, stepId, alt }: { taskId: number; stepId: number; alt: string }) {
  const src = screenUrl(taskId, stepId);
  return (
    <a className="shot" href={src} target="_blank" rel="noreferrer">
      <img src={src} alt={alt} loading="lazy" />
    </a>
  );
}

function lastLine(text?: string) {
  const lines = text?.split("\n") ?? [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = plainText(lines[i] as string);
    if (line) return line;
  }
}

export function taskLine(t: TaskCard, progress?: string): string {
  if (t.summary && !isActive(t)) return t.summary;
  switch (t.status) {
    case "queued":
      return t.lane === "screen" ? "Waiting for the screen." : "Queued.";
    case "waiting_approval":
      return "Waiting for your approval.";
    case "waiting_takeover":
      return "Waiting for you to take over.";
    case "waiting_answer":
      return "Waiting for your answer.";
    default:
      return lastLine(progress) ?? "Working…";
  }
}

/** A negotiation's mandate takes a note too: it can change the numbers. */
export const MANDATE_NOTE = "Change the numbers, or tell it how to go about it";

/** Approvals whose answer can carry a note to the task: the task carries on afterwards. */
export const takesNote = (a: Approval) => a.kind !== "budget" && a.kind !== "injection_warning";

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
  useEffect(() => ensureApproval(approvalId), [approvalId]);
  if (!a) return null;

  if (a.status !== "pending") {
    const [cls, label] = RESOLVED[a.status];
    return (
      <div className="resolved-line">
        <span className={`status ${cls}`}>
          {a.status === "approved" && <Icon name="check" />}
          {a.status === "denied" && <Icon name="x" />}
          {label}
        </span>
        <span className="muted">
          {a.summary}
          {a.note && ` You said: ${a.note}`}
        </span>
      </div>
    );
  }

  return (
    <div className="card attn">
      <PendingApproval
        a={a}
        links={
          showDetails &&
          a.taskId && (
            <Link className="btn sm ghost" to={`/tasks/${a.taskId}`}>
              Open task
            </Link>
          )
        }
      />
    </div>
  );
}

/**
 * Trusting where what the work read came from, so what comes after doesn't ask for it: the schedule
 * or watcher the chat wrote that started its task, or the conversation it asks in.
 */
function TrustButton({ a, onError }: { a: Approval; onError: (error: string) => void }) {
  const task = useStore((s) => (a.taskId ? s.tasks[a.taskId] : undefined));
  const schedule = useStore((s) => (task?.scheduleId ? s.schedules[task.scheduleId] : undefined));
  const watcher = useStore((s) => (task?.watcherId ? s.watchers[task.watcherId] : undefined));
  const [trusted, setTrusted] = useState(false);
  useEffect(() => {
    if (a.taskId) ensureTask(a.taskId);
  }, [a.taskId]);
  useEffect(() => {
    if (task?.scheduleId) ensureSchedule(task.scheduleId);
    if (task?.watcherId) ensureWatcher(task.watcherId);
  }, [task?.scheduleId, task?.watcherId]);
  const { conversationId, episodeId } = a;
  const chat = !a.taskId && !trusted && a.sources.length > 0 && conversationId && episodeId;
  const [what, trust] = schedule?.tainted
    ? ["this schedule", () => trustSchedule(schedule.id)]
    : watcher?.tainted
      ? ["this watcher", () => trustWatcher(watcher.id)]
      : chat
        ? ["this chat", () => trustConversation(conversationId, episodeId)]
        : [null, null];
  if (!what || !trust) return null;
  return (
    <button
      type="button"
      className="btn sm ghost"
      title={`Trust ${what}: what it read doesn't make what comes after ask`}
      onClick={() =>
        trust().then(
          () => setTrusted(true),
          (err) => onError(errorText(err)),
        )
      }
    >
      Trust
    </button>
  );
}

/** Every field is plain text, never Markdown, which could hide part of a command. */
export function PendingApproval({
  a,
  links,
  compact = false,
}: {
  a: Approval;
  links?: React.ReactNode;
  /** The chat's tray: the screenshot, the note and (unless it warns) why it asks wait behind More. */
  compact?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [more, setMore] = useState(!compact);
  const shot =
    a.taskId && a.screenshotStepId ? (
      <Shot taskId={a.taskId} stepId={a.screenshotStepId} alt="The screen before this step" />
    ) : null;
  // When something it read may be steering the bot, why it asks is the warning, so it never folds.
  const warns = a.kind === "injection_warning" || a.sources.length > 0;
  const why = more || warns;
  const folds = compact && ((a.reason && !warns) || shot || takesNote(a));

  const decide = async (decision: "approve" | "deny", scope?: ApprovalScope) => {
    setBusy(true);
    setError("");
    try {
      await decideApproval(a.id, decision, note, scope);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <div className="approval">
      <div className={more && shot ? "thumb-wrap" : undefined}>
        <div className="approval-text">
          <p className="approval-what">{a.summary}</p>
          {why && a.reason && <p>{a.reason}</p>}
          {a.sources.length > 0 && <p className="muted">After reading {a.sources.join(", ")}</p>}
        </div>
        {more && shot}
      </div>
      {more && takesNote(a) && (
        <textarea
          className="field approval-note"
          aria-label="Note"
          rows={2}
          maxLength={4000}
          value={note}
          placeholder={
            a.kind === "mandate" ? MANDATE_NOTE : "Tell it what to do instead, or how to go ahead"
          }
          onChange={(e) => setNote(e.target.value)}
        />
      )}
      {error && <div className="form-error">{error}</div>}
      <div className="approval-actions">
        {links}
        <TrustButton a={a} onError={setError} />
        {folds && (
          <button
            type="button"
            className="btn sm ghost"
            aria-expanded={more}
            onClick={() => setMore((v) => !v)}
          >
            {more ? "Less" : "More"}
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
        {a.scopes.includes("always") && (
          <button
            type="button"
            className="btn"
            disabled={busy}
            title="Approve this exact action from now on"
            onClick={() => decide("approve", "always")}
          >
            Always
          </button>
        )}
        {a.scopes.includes("session") && (
          <button
            type="button"
            className="btn"
            disabled={busy}
            title={`Approve ${a.taskId ? "this task's" : "this conversation's"} calls like this on the same thing`}
            onClick={() => decide("approve", "session")}
          >
            {a.taskId ? "For this task" : "For this chat"}
          </button>
        )}
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

export function PendingQuestion({ q, links }: { q: Question; links?: React.ReactNode }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [own, setOwn] = useState("");
  const answer = async (text: string) => {
    if (!text.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      await answerQuestion(q.id, text.trim());
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };
  return (
    <div className="approval">
      <div className="approval-text">
        <p className="question-what">{q.question}</p>
        {q.sources.length > 0 && <p className="muted">After reading {q.sources.join(", ")}</p>}
      </div>
      <form
        className="answer-row"
        onSubmit={(e) => {
          e.preventDefault();
          void answer(own);
        }}
      >
        <input
          className="field"
          aria-label="Your answer"
          placeholder={q.choices.length ? "Or write your own" : "Your answer"}
          maxLength={4000}
          value={own}
          onChange={(e) => setOwn(e.target.value)}
        />
        <button type="submit" className="btn" disabled={busy || !own.trim()}>
          Send
        </button>
      </form>
      {error && <div className="form-error">{error}</div>}
      <div className="approval-actions">
        {links}
        <span className="spacer" />
        {q.choices.map((c) => (
          <button
            key={c}
            type="button"
            className="btn primary"
            disabled={busy}
            onClick={() => answer(c)}
          >
            {c}
          </button>
        ))}
      </div>
    </div>
  );
}

/** "Every day at 08:00", or "Once, Sat 11 Oct, 08:00". */
export function whenText(s: Pick<Schedule, "cron" | "runAt">): string {
  if (s.cron) return describeCron(s.cron);
  if (!s.runAt) return "";
  return `Once, ${stamp(s.runAt)}`;
}
