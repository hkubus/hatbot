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
import { errorText } from "./api";
import { plainText } from "./format";
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

/** The last line Hatbot wrote or thought, for a running task, without its Markdown. */
function lastLine(text?: string) {
  const lines = text?.split("\n") ?? [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = plainText(lines[i] as string);
    if (line) return line;
  }
}

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

  return (
    <div className="card attn">
      <PendingApproval
        a={a}
        links={
          showDetails &&
          a.taskId && (
            <button
              type="button"
              className="btn sm ghost"
              onClick={() => navigate(`/tasks/${a.taskId}`)}
            >
              Details
            </button>
          )
        }
      />
    </div>
  );
}

/**
 * An approval waiting for you, with Deny and Approve: a card on its task's page, and in the chat's
 * tray. Every field is plain text, never Markdown, which could hide part of a command.
 */
export function PendingApproval({
  a,
  links,
  compact = false,
}: {
  a: Approval;
  /** Buttons to where it came from: its task, or its negotiation. */
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

  const decide = async (decision: "approve" | "deny") => {
    setBusy(true);
    setError("");
    try {
      await decideApproval(a.id, decision, note);
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
