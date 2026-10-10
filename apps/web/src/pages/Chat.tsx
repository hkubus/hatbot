import type { ThreadMessage } from "@hatbot/shared";
import { Fragment, memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ApiError } from "../api";
import { Icon } from "../icons";
import { navigate } from "../router";
import {
  decideApproval,
  ensureApproval,
  ensureSchedule,
  ensureTask,
  getState,
  loadEarlier,
  loadThread,
  sendMessage,
  setPaused,
  useStore,
} from "../store";
import { isActive, Shot, taskLine, whenText } from "../tasks";

const time = (iso: string) =>
  new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: d.getFullYear() === today.getFullYear() ? undefined : "numeric",
  });
}

// Links open in a new tab; raw HTML in replies is never rendered (react-markdown's default).
const MD_COMPONENTS = {
  a: (props: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a {...props} target="_blank" rel="noreferrer noopener" />
  ),
};

const AssistantBody = memo(function AssistantBody({ text }: { text: string }) {
  return (
    <div className="md">
      <Markdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
        {text}
      </Markdown>
    </div>
  );
});

/** Time, then actions that show on hover (or a tap on touch screens). */
function Meta({
  m,
  copy,
  open,
}: {
  m: ThreadMessage;
  copy?: string;
  open?: { to: string; label: string };
}) {
  const [copied, setCopied] = useState(false);
  const doCopy = async () => {
    if (!copy) return;
    await navigator.clipboard?.writeText(copy).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="meta">
      <span className="time">{time(m.createdAt)}</span>
      <span className="msg-actions">
        {copy && (
          <button type="button" className="msg-act" title="Copy" onClick={doCopy}>
            <Icon name={copied ? "check" : "copy"} />
          </button>
        )}
        {open && (
          <button
            type="button"
            className="msg-act"
            title={open.label}
            onClick={() => navigate(open.to)}
          >
            <Icon name="chevron" />
          </button>
        )}
      </span>
    </div>
  );
}

/** A task, as a message: what it's doing while it runs, then how it ended. */
function TaskMessage({ m, taskId }: { m: ThreadMessage; taskId: number }) {
  const task = useStore((s) => s.tasks[taskId]);
  const progress = useStore((s) => s.taskProgress[taskId]);
  const control = useStore((s) => s.desktop?.control);
  useEffect(() => ensureTask(taskId), [taskId]);
  if (!task) return null;
  const active = isActive(task);
  let text: string;
  if (active) text = `**${task.title}**`;
  else if (task.status === "done") text = `**${task.title}**\n\n${task.summary ?? "Done."}`;
  else if (task.status === "failed")
    text = `**${task.title}** didn't finish.${task.summary ? `\n\n${task.summary}` : ""}`;
  else text = `**${task.title}** was cancelled.`;
  const note =
    active && control === "owner" && task.status === "running"
      ? "Paused while you have control."
      : taskLine(task, progress);
  return (
    <>
      <div className="body">
        <AssistantBody text={text} />
        {active && <div className="progress-note">{note}</div>}
      </div>
      <Meta
        m={m}
        copy={active ? undefined : (task.summary ?? task.title)}
        open={{ to: `/tasks/${taskId}`, label: "Open task" }}
      />
    </>
  );
}

/** A task under the reply that started it: working dots, then how it ended. */
function TaskResult({ taskId }: { taskId: number }) {
  const task = useStore((s) => s.tasks[taskId]);
  const progress = useStore((s) => s.taskProgress[taskId]);
  const control = useStore((s) => s.desktop?.control);
  useEffect(() => ensureTask(taskId), [taskId]);
  if (!task) return null;
  if (isActive(task)) {
    const note =
      control === "owner" && task.status === "running"
        ? "Paused while you have control."
        : taskLine(task, progress);
    return (
      <div className="task-working">
        <div className="typing">
          <span />
          <span />
          <span />
        </div>
        {note !== "Working…" && <div className="progress-note">{note}</div>}
      </div>
    );
  }
  if (task.status === "done") return <AssistantBody text={task.summary ?? "Done."} />;
  if (task.status === "failed")
    return <AssistantBody text={`**Didn't finish.** ${task.summary ?? ""}`} />;
  return <div className="muted resolved">Cancelled.</div>;
}

/** Hatbot's reply, with the task it started (if any) working and then reporting under it. */
function ReplyMessage({ m, progress }: { m: ThreadMessage; progress?: string }) {
  const task = useStore((s) => (m.taskId ? s.tasks[m.taskId] : undefined));
  const streaming = m.status === "streaming";
  const note = progress?.trim().split("\n").filter(Boolean).at(-1);
  const result = task && !isActive(task) ? task.summary : null;
  return (
    <>
      <div className="body">
        {m.text && <AssistantBody text={m.text} />}
        {streaming && !m.text && !m.taskId && (
          <div className="typing">
            <span />
            <span />
            <span />
          </div>
        )}
        {streaming && note && <div className="progress-note">{note}</div>}
        {m.taskId && <TaskResult taskId={m.taskId} />}
      </div>
      {!streaming && (
        <Meta
          m={m}
          copy={result ? `${m.text}\n\n${result}`.trim() : m.text}
          open={m.taskId ? { to: `/tasks/${m.taskId}`, label: "Open task" } : undefined}
        />
      )}
    </>
  );
}

/** An approval, as a message with Approve and Deny under it. */
function ApprovalMessage({ m, approvalId }: { m: ThreadMessage; approvalId: number }) {
  const a = useStore((s) => s.approvals[approvalId]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => ensureApproval(approvalId), [approvalId]);
  if (!a) return null;
  const open = a.taskId ? { to: `/tasks/${a.taskId}`, label: "Open task" } : undefined;
  if (a.status !== "pending") {
    const word = {
      approved: "Approved",
      denied: "Denied",
      expired: "Expired",
      cancelled: "Cancelled",
    }[a.status];
    return (
      <>
        <div className="body">
          <div className="muted resolved">
            {word}: {a.summary}
          </div>
        </div>
        <Meta m={m} copy={a.summary} open={open} />
      </>
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
  const text = [
    `**Can I go ahead?** ${a.summary}`,
    a.reason,
    a.sources.length ? `_After reading ${a.sources.join(", ")}_` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  return (
    <>
      <div className="body">
        <AssistantBody text={text} />
        {a.taskId && a.screenshotStepId && (
          <Shot taskId={a.taskId} stepId={a.screenshotStepId} alt="The screen before this step" />
        )}
        {error && <div className="form-error">{error}</div>}
        <div className="msg-buttons">
          <button type="button" className="btn sm" disabled={busy} onClick={() => decide("deny")}>
            Deny
          </button>
          <button
            type="button"
            className="btn sm primary"
            disabled={busy}
            onClick={() => decide("approve")}
          >
            Approve
          </button>
        </div>
      </div>
      <Meta m={m} copy={a.summary} open={open} />
    </>
  );
}

/** A schedule Hatbot made, as one line. */
function ScheduleMessage({ m, scheduleId }: { m: ThreadMessage; scheduleId: number }) {
  const s = useStore((st) => st.schedules[scheduleId]);
  useEffect(() => ensureSchedule(scheduleId), [scheduleId]);
  if (s === undefined) return null;
  const text = s
    ? `Scheduled **${s.name}**: ${whenText(s).replace(/^\w/, (c) => c.toLowerCase())}.`
    : "Made a schedule that's since been deleted.";
  return (
    <>
      <div className="body">
        <AssistantBody text={text} />
      </div>
      <Meta
        m={m}
        copy={s ? s.prompt : undefined}
        open={s ? { to: `/schedules/${s.id}`, label: "Open schedule" } : undefined}
      />
    </>
  );
}

function Message({
  m,
  progress,
  animate,
}: {
  m: ThreadMessage;
  progress?: string;
  animate: boolean;
}) {
  // Touch screens have no hover: a tap shows the message's actions.
  const [tapped, setTapped] = useState(false);
  const cls = `msg ${m.role === "user" ? "user" : ""} ${animate ? "new" : ""} ${tapped ? "tapped" : ""}`;
  let inner: React.ReactNode;
  if (m.role === "user") {
    inner = (
      <>
        <div className="bubble">{m.text}</div>
        <Meta m={m} copy={m.text} />
      </>
    );
  } else if (m.kind === "task" && m.taskId) {
    inner = <TaskMessage m={m} taskId={m.taskId} />;
  } else if (m.kind === "approval" && m.approvalId) {
    inner = <ApprovalMessage m={m} approvalId={m.approvalId} />;
  } else if (m.kind === "schedule" && m.scheduleId) {
    inner = <ScheduleMessage m={m} scheduleId={m.scheduleId} />;
  } else {
    inner = <ReplyMessage m={m} progress={progress} />;
  }
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/noStaticElementInteractions: a tap only reveals the buttons, which are reachable by keyboard anyway
    <div className={cls} onClick={() => setTapped((v) => !v)}>
      {inner}
    </div>
  );
}

export function Chat() {
  const messages = useStore((s) => s.messages);
  const progress = useStore((s) => s.progress);
  const hasEarlier = useStore((s) => s.hasEarlier);
  const paused = useStore((s) => s.paused);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const scroller = useRef<HTMLElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const thread = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  // Only messages that arrive after the first paint animate in.
  const animateFrom = useRef<number>(Number.POSITIVE_INFINITY);

  useEffect(() => {
    loadThread().then(() => {
      animateFrom.current = (getState().messages.at(-1)?.id ?? 0) + 1;
    });
  }, []);

  // Follow the conversation while the view is at the bottom.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });
  // Cards and screenshots load after the messages and grow the thread; keep following.
  useEffect(() => {
    const el = scroller.current;
    const content = thread.current;
    if (!el || !content) return;
    const ro = new ResizeObserver(() => {
      if (stick.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, []);

  const onScroll = () => {
    const el = scroller.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const earlier = async () => {
    const el = scroller.current;
    const before = el ? el.scrollHeight - el.scrollTop : 0;
    stick.current = false;
    await loadEarlier();
    requestAnimationFrame(() => {
      if (el) el.scrollTop = el.scrollHeight - before;
    });
  };

  const resize = () => {
    const ta = textarea.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
  };

  const send = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setError("");
    stick.current = true;
    try {
      await sendMessage(text);
      setDraft("");
      requestAnimationFrame(resize);
    } catch {
      setError("Couldn't send. Check your connection and try again.");
    } finally {
      setSending(false);
    }
  };

  let lastDay = "";
  return (
    <>
      <section className="view" ref={scroller} onScroll={onScroll}>
        <div className="chat-scroll">
          {paused && (
            <div className="paused-banner">
              <Icon name="pause" />
              All activity is paused.
              <span style={{ flex: 1 }} />
              <button type="button" className="btn sm" onClick={() => setPaused(false)}>
                Resume
              </button>
            </div>
          )}
          <div className="thread" ref={thread}>
            {hasEarlier && (
              <button type="button" className="btn sm ghost load-earlier" onClick={earlier}>
                Earlier messages
              </button>
            )}
            {!messages.length && <div className="empty">Say hello to Hatbot.</div>}
            {messages.map((m) => {
              const day = dayLabel(m.createdAt);
              const showDay = day !== lastDay;
              lastDay = day;
              return (
                <Fragment key={m.id}>
                  {showDay && <div className="day">{day}</div>}
                  <Message m={m} progress={progress[m.id]} animate={m.id >= animateFrom.current} />
                </Fragment>
              );
            })}
          </div>
        </div>
      </section>
      <div className="composer-wrap">
        {error && (
          <div className="form-error" style={{ maxWidth: 760, margin: "0 auto 6px" }}>
            {error}
          </div>
        )}
        <div className="composer">
          <textarea
            ref={textarea}
            rows={1}
            placeholder="Message Hatbot…"
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              resize();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <button
            type="button"
            className="icon-btn send"
            title="Send"
            disabled={!draft.trim() || sending}
            onClick={send}
          >
            <Icon name="up" />
          </button>
        </div>
      </div>
    </>
  );
}
