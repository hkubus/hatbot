// Task status, screenshots and the approval card, shared by the chat and the Tasks page.
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
import { Icon } from "./icons";
import { navigate } from "./router";
import { decideApproval, ensureApproval, useStore } from "./store";

const STATUS: Record<TaskStatus, [string, string]> = {
  queued: ["", "Queued"],
  running: ["brand", "Running"],
  waiting_approval: ["attn", "Needs approval"],
  waiting_takeover: ["attn", "Needs you"],
  done: ["ok", "Done"],
  failed: ["bad", "Failed"],
  cancelled: ["", "Cancelled"],
};

/** 950, 12.4k, 3.1M. */
export const tokenText = (n: number) =>
  n < 1000
    ? String(n)
    : n < 1_000_000
      ? `${(n / 1000).toFixed(1)}k`
      : `${(n / 1_000_000).toFixed(1)}M`;

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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
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
        <span className="muted">
          {a.summary}
          {a.note && ` You said: ${a.note}`}
        </span>
      </div>
    );
  }

  const decide = async (decision: "approve" | "deny") => {
    setBusy(true);
    setError("");
    try {
      await decideApproval(a.id, decision, note);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't reach Hatbot.");
      setBusy(false);
    }
  };

  return (
    <div className="card attn">
      <div className="card-head">
        <div className="title full">{a.summary}</div>
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
        {takesNote(a) && (
          <textarea
            className="field approval-note"
            rows={2}
            maxLength={4000}
            value={note}
            placeholder="Tell it what to do instead, or how to go ahead"
            onChange={(e) => setNote(e.target.value)}
          />
        )}
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
