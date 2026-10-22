import {
  type Approval,
  type Attachment,
  type MessageLink,
  matchingCommands,
  type Source,
  type ThreadMessage,
  threadGroups,
} from "@hatbot/shared";
import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ApiError, attachmentUrl, errorText } from "../api";
import { ask } from "../confirm";
import {
  attachFiles,
  type DraftFile,
  draftText,
  PICTURES,
  removeFile,
  saveDraftText,
  setDraftFiles,
  useDraftFiles,
} from "../drafts";
import { plainText, time } from "../format";
import { Icon } from "../icons";
import { Link } from "../link";
import { LoadError } from "../load";
import { AssistantBody, isMarkdownFile, useCopy } from "../markdown";
import { touchScreen } from "../media";
import { negotiationText } from "../negotiations";
import { navigate, useRoute } from "../router";
import {
  botName,
  chatName,
  chatPath,
  currentChat,
  deleteEpisode,
  ensureBox,
  ensureNegotiation,
  ensureSchedule,
  ensureTask,
  getState,
  loadEarlier,
  loadThread,
  markSeen,
  negotiationOf,
  openConversation,
  retryReply,
  sendMessage,
  trustSchedule,
  useStore,
} from "../store";
import {
  isActive,
  PendingApproval,
  PendingQuestion,
  taskLine,
  tokenText,
  whenText,
} from "../tasks";
import { splitWaiting } from "../waiting";

const SEEN_AFTER_MS = 1500;

const DAY = new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long" });
const DAY_YEAR = new Intl.DateTimeFormat("en-GB", {
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
});
// Each message's day, worked out once: the thread asks for every message's on every render. Kept for
// one day, as "Today" becomes "Yesterday" at midnight.
const days = new Map<string, string>();
let daysOn = "";

/** "Today", "Yesterday", "Saturday 17 October", or with the year when it isn't this one. */
export function dayLabel(iso: string, now: Date): string {
  const today = now.toDateString();
  if (daysOn !== today) {
    days.clear();
    daysOn = today;
  }
  let label = days.get(iso);
  if (label === undefined) {
    const d = new Date(iso);
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    label =
      d.toDateString() === today
        ? "Today"
        : d.toDateString() === yesterday.toDateString()
          ? "Yesterday"
          : (d.getFullYear() === now.getFullYear() ? DAY : DAY_YEAR).format(d);
    days.set(iso, label);
  }
  return label;
}

function Meta({
  m,
  copy,
  open,
  retry,
}: {
  m: ThreadMessage;
  copy?: string;
  open?: { to: string; label: string };
  retry?: () => Promise<unknown>;
}) {
  const [copied, doCopy] = useCopy();
  const [retrying, setRetrying] = useState(false);
  const [retryFailed, setRetryFailed] = useState(false);
  return (
    <div className="meta">
      <span className="time">{time(m.createdAt)}</span>
      {/* A task's result changed the message after it was sent. */}
      {m.editedAt && <span className="edited">Edited {time(m.editedAt)}</span>}
      <span className="msg-actions">
        {copy && (
          <button
            type="button"
            className="msg-act"
            title="Copy"
            onClick={() => copy && doCopy(copy)}
          >
            <Icon name={copied ? "check" : "copy"} />
          </button>
        )}
        {retry && (
          <button
            type="button"
            className="msg-act"
            title={retryFailed ? "Couldn't try again" : "Try again"}
            disabled={retrying}
            onClick={() => {
              setRetrying(true);
              setRetryFailed(false);
              retry().then(
                () => setRetrying(false),
                () => {
                  setRetrying(false);
                  setRetryFailed(true);
                },
              );
            }}
          >
            <Icon name="undo" />
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

function TaskMessage({ m, taskId }: { m: ThreadMessage; taskId: number }) {
  const task = useStore((s) => s.tasks[taskId]);
  const progress = useStore((s) => s.taskProgress[taskId]);
  const control = useStore((s) => s.desktop?.control);
  const open = useLinkOpen(m.link) ?? { to: `/tasks/${taskId}`, label: "Open task" };
  useEffect(() => ensureTask(taskId), [taskId]);
  // Until it loads (it's fetched again after a reconnect if it failed), the card's own line.
  if (!task)
    return (
      <>
        <div className="body">
          <div className="muted card-pending">{plainText(m.text) || `Task #${taskId}`}</div>
        </div>
        <Meta m={m} open={open} />
      </>
    );
  const active = isActive(task);
  let text: string;
  let result = "";
  if (active) text = `**${task.title}**`;
  else if (task.status === "done") {
    text = `**${task.title}**`;
    result = task.summary ?? "Done.";
  } else if (task.status === "failed") {
    text = `**${task.title}** didn't finish.`;
    result = task.summary ?? "";
  } else text = `**${task.title}** was cancelled.`;
  const note =
    active && control === "owner" && task.status === "running"
      ? "Paused while you have control."
      : taskLine(task, progress);
  return (
    <>
      <div className="body">
        <AssistantBody text={text} />
        {result && <AssistantBody text={result} />}
        {active && <div className="progress-note">{note}</div>}
        {m.attachments?.length ? <Files list={m.attachments} /> : null}
      </div>
      <Meta m={m} copy={active ? undefined : (task.summary ?? task.title)} open={open} />
    </>
  );
}

function TaskResult({ taskId }: { taskId: number }) {
  const task = useStore((s) => s.tasks[taskId]);
  const progress = useStore((s) => s.taskProgress[taskId]);
  const control = useStore((s) => s.desktop?.control);
  useEffect(() => ensureTask(taskId), [taskId]);
  if (!task) return <div className="muted card-pending">Task #{taskId}</div>;
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

function NegotiationResult({ id }: { id: number }) {
  const n = useStore((s) => s.negotiations[id]);
  useEffect(() => ensureNegotiation(id), [id]);
  if (!n) return null;
  return (
    <div className="md">
      <p>
        <a href={n.listingUrl} target="_blank" rel="noreferrer noopener">
          <b>{n.title}</b>
        </a>
        : {negotiationText(n)}
      </p>
    </div>
  );
}

function BoxResult({ id }: { id: number }) {
  const box = useStore((s) => s.boxes[id]);
  useEffect(() => ensureBox(id), [id]);
  if (!box) return null;
  return (
    <div className="box-line">
      <Icon name="box" />
      <b>{box.title}</b>
      <Link className="btn sm" to={`/boxes/${id}`}>
        Open
      </Link>
    </div>
  );
}

/** Opened at the message, so the hand-off reads with what came of it. */
function useLinkOpen(link: MessageLink | undefined) {
  const label = useStore((s) => {
    if (!link) return "";
    const c = s.conversations.find((x) => x.id === link.conversationId);
    if (!c) return "Open in the other chat";
    return c.kind === "direct" ? `Open in ${chatName(s, c)}'s chat` : `Open in ${chatName(s, c)}`;
  });
  return link
    ? { to: `${chatPath(link.conversationId)}?message=${link.messageId}`, label }
    : undefined;
}

/** One a task asked for has no chat to go back to; its task page says which task. */
function HandoffMessage({ m }: { m: ThreadMessage }) {
  const name = useStore((s) => botName(s, m.botId));
  const open =
    useLinkOpen(m.link) ??
    (m.taskId ? { to: `/tasks/${m.taskId}`, label: "Open task" } : undefined);
  return (
    <>
      <div className="body">
        <p>
          <b>{name} asked:</b>
        </p>
        <AssistantBody text={m.text} />
      </div>
      <Meta m={m} copy={m.text} open={open} />
    </>
  );
}

/** The box's words, neither yours nor the bot's: plain text. */
function BoxNote({ m }: { m: ThreadMessage }) {
  const box = useStore((s) => (m.boxId ? s.boxes[m.boxId] : null));
  useEffect(() => {
    if (m.boxId) ensureBox(m.boxId);
  }, [m.boxId]);
  return (
    <>
      <div className="body">
        <p className="box-note">
          <b>From {box?.title ?? "a box"}:</b> {m.text}
        </p>
      </div>
      <Meta
        m={m}
        copy={m.text}
        open={box ? { to: `/boxes/${box.id}`, label: "Open box" } : undefined}
      />
    </>
  );
}

/**
 * Hatbot's reply, with the task it started (if any) working under it. Once the task finishes or fails,
 * its bot writes the reply again to say what came of it; if it doesn't, the task's result shows in the
 * reply's place. A cancelled task leaves the reply.
 */
function ReplyMessage({
  m,
  progress,
  retryable,
  answerable,
}: {
  m: ThreadMessage;
  progress?: string;
  retryable: boolean;
  answerable: boolean;
}) {
  const task = useStore((s) => (m.taskId ? s.tasks[m.taskId] : undefined));
  const used = useStore((s) => s.usage[m.id]);
  // A hand-off: its chat shows the task's status too, and how the other bot answered.
  const handedOff = useLinkOpen(m.link);
  const streaming = m.status === "streaming";
  const note = progress?.trim().split("\n").filter(Boolean).at(-1);
  const ended = task && !isActive(task) ? task : null;
  const finished = ended !== null && ended.status !== "cancelled";
  // Its bot didn't write it again: told some other way, or it failed to.
  const replaced = finished && !streaming && (m.status === "error" || !m.text);
  return (
    <>
      <div className="body">
        {replaced && m.taskId && <TaskResult taskId={m.taskId} />}
        {replaced && m.text && <hr className="result-rule" />}
        {m.text && <AssistantBody text={m.text} streaming={streaming} />}
        {streaming && !m.text && (!m.taskId || finished) && (
          <div className="typing">
            <span />
            <span />
            <span />
          </div>
        )}
        {streaming && note && <div className="progress-note">{note}</div>}
        {streaming && used && (
          <div className="progress-note tnum">
            {tokenText(used.tokens)} tokens · ${used.costUsd.toFixed(3)}
          </div>
        )}
        {!streaming && m.sources?.length ? <Sources list={m.sources} /> : null}
        {answerable && m.choices?.length ? <Choices lists={m.choices} /> : null}
        {m.negotiationId && <NegotiationResult id={m.negotiationId} />}
        {m.boxId && <BoxResult id={m.boxId} />}
        {ended && !finished && m.text && <hr className="result-rule" />}
        {m.taskId && !finished && <TaskResult taskId={m.taskId} />}
        {m.attachments?.length ? <Files list={m.attachments} /> : null}
      </div>
      {!streaming && (
        <Meta
          m={m}
          copy={replaced ? (ended.summary ?? "") : m.text}
          open={
            m.negotiationId
              ? { to: `/negotiations/${m.negotiationId}`, label: "Open negotiation" }
              : m.boxId
                ? { to: `/boxes/${m.boxId}`, label: "Open box" }
                : (handedOff ??
                  (m.taskId ? { to: `/tasks/${m.taskId}`, label: "Open task" } : undefined))
          }
          retry={retryable && m.status === "error" ? () => retryReply(m) : undefined}
        />
      )}
    </>
  );
}

function TrayApproval({ a }: { a: Approval }) {
  const negotiation = useStore((s) => (a.kind === "mandate" ? negotiationOf(s, a.id) : undefined));
  return (
    <PendingApproval
      a={a}
      compact
      links={
        a.taskId ? (
          <button
            type="button"
            className="btn sm ghost"
            onClick={() => navigate(`/tasks/${a.taskId}`)}
          >
            Open task
          </button>
        ) : negotiation ? (
          <button
            type="button"
            className="btn sm ghost"
            onClick={() => navigate(`/negotiations/${negotiation.id}`)}
          >
            Open negotiation
          </button>
        ) : null
      }
    />
  );
}

function ScheduleMessage({ m, scheduleId }: { m: ThreadMessage; scheduleId: number }) {
  const s = useStore((st) => st.schedules[scheduleId]);
  useEffect(() => ensureSchedule(scheduleId), [scheduleId]);
  if (s === undefined)
    return (
      <>
        <div className="body">
          <div className="muted card-pending">{plainText(m.text)}</div>
        </div>
        <Meta m={m} open={{ to: `/schedules/${scheduleId}`, label: "Open schedule" }} />
      </>
    );
  const text = s
    ? `Scheduled **${s.name}**: ${whenText(s).replace(/^\w/, (c) => c.toLowerCase())}.`
    : "Made a schedule that's since been deleted.";
  return (
    <>
      <div className="body">
        <AssistantBody text={text} />
        {s?.tainted && (
          <button
            type="button"
            className="btn sm"
            title="It was written after reading untrusted content; trusted, its runs don't ask for that"
            onClick={() => void trustSchedule(s.id).catch(() => {})}
          >
            Trust
          </button>
        )}
      </div>
      <Meta
        m={m}
        copy={s ? s.prompt : undefined}
        open={s ? { to: `/schedules/${s.id}`, label: "Open schedule" } : undefined}
      />
    </>
  );
}

/**
 * The answers the questions at the end of a reply offer. For one, a tap sends it as your message; for
 * several, you pick or write each answer and send them together, numbered like the questions.
 */
function Choices({ lists }: { lists: string[][] }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [answers, setAnswers] = useState<string[]>(() => lists.map(() => ""));
  const send = async (text: string) => {
    setBusy(true);
    setError("");
    try {
      await sendMessage(text, [], randomId());
    } catch (err) {
      setError(sendError(err, getState().connected));
      setBusy(false);
    }
  };
  const set = (i: number, answer: string) =>
    setAnswers((a) => a.map((x, j) => (j === i ? answer : x)));
  const one = lists.length === 1 ? lists[0] : undefined;
  return (
    <>
      {one ? (
        <div className="choices">
          {one.map((c) => (
            <button key={c} type="button" className="btn" disabled={busy} onClick={() => send(c)}>
              {c}
            </button>
          ))}
        </div>
      ) : (
        <form
          className="choice-form"
          onSubmit={(e) => {
            e.preventDefault();
            void send(answers.map((a, i) => `${i + 1}. ${a.trim()}`).join("\n"));
          }}
        >
          {lists.map((list, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the questions are fixed, in order
            <div key={i} className="choices">
              <span className="choice-num tnum">{i + 1}.</span>
              {list.length ? (
                list.map((c) => (
                  <button
                    key={c}
                    type="button"
                    className={`btn ${answers[i] === c ? "primary" : ""}`}
                    aria-pressed={answers[i] === c}
                    disabled={busy}
                    onClick={() => set(i, c)}
                  >
                    {c}
                  </button>
                ))
              ) : (
                <input
                  className="field"
                  aria-label={`Answer ${i + 1}`}
                  maxLength={1000}
                  value={answers[i]}
                  onChange={(e) => set(i, e.target.value)}
                />
              )}
            </div>
          ))}
          <div>
            <button
              type="submit"
              className="btn primary"
              disabled={busy || answers.some((a) => !a.trim())}
            >
              Send
            </button>
          </div>
        </form>
      )}
      {error && <div className="form-error">{error}</div>}
    </>
  );
}

function Sources({ list }: { list: Source[] }) {
  return (
    <div className="sources">
      Sources:{" "}
      {list.map((s, i) => (
        <span key={s.url}>
          {i > 0 && " · "}
          <a href={s.url} target="_blank" rel="noreferrer" title={s.url}>
            {s.title.length > 60 ? `${s.title.slice(0, 59)}…` : s.title}
          </a>
        </span>
      ))}
    </div>
  );
}

function Files({ list }: { list: Attachment[] }) {
  return (
    <div className="files">
      {list.map((a) =>
        PICTURES.includes(a.mediaType) ? (
          <a
            key={a.id}
            className="file-picture"
            href={attachmentUrl(a.id)}
            target="_blank"
            rel="noreferrer"
          >
            {/* Bubbles are at most 240 px: a copy that size, not the whole photo. */}
            <img
              src={`${attachmentUrl(a.id)}?w=480`}
              srcSet={`${attachmentUrl(a.id)}?w=480 2x, ${attachmentUrl(a.id)}?w=720 3x`}
              alt={a.name}
              loading="lazy"
            />
          </a>
        ) : isMarkdownFile(a) ? (
          <Link key={a.id} className="file" to={`/read?file=${a.id}`}>
            <Icon name="file" />
            {a.name}
          </Link>
        ) : (
          <a
            key={a.id}
            className="file"
            href={attachmentUrl(a.id, a.mediaType !== "application/pdf")}
            target="_blank"
            rel="noreferrer"
          >
            <Icon name="file" />
            {a.name}
          </a>
        ),
      )}
    </div>
  );
}

type Option = { key: string; label: React.ReactNode; desc: string; choose: () => void };

// Memoized: while a reply streams only its own message redraws, not the whole thread's markdown.
export const Message = memo(function Message({
  m,
  progress,
  animate,
  unread,
  retryable = false,
  answerable = false,
}: {
  m: ThreadMessage;
  progress?: string;
  animate: boolean;
  retryable?: boolean;
  answerable?: boolean;
  unread: boolean;
}) {
  // Touch screens have no hover: a tap shows the message's actions.
  const [tapped, setTapped] = useState(false);
  if (m.role === "assistant" && m.kind === "command" && !m.taskId)
    return (
      <div className="msg-note" data-id={m.id}>
        {m.text}
      </div>
    );
  const cls = `msg ${m.role === "user" ? "user" : ""} ${animate ? "new" : ""} ${tapped ? "tapped" : ""} ${unread ? "unread" : ""}`;
  let inner: React.ReactNode;
  if (m.role === "user") {
    inner = (
      <>
        {m.attachments?.length ? <Files list={m.attachments} /> : null}
        {m.text && <div className="bubble">{m.text}</div>}
        <Meta m={m} copy={m.text} />
      </>
    );
  } else if (m.kind === "task" && m.taskId) {
    inner = <TaskMessage m={m} taskId={m.taskId} />;
  } else if (m.kind === "schedule" && m.scheduleId) {
    inner = <ScheduleMessage m={m} scheduleId={m.scheduleId} />;
  } else if (m.kind === "box") {
    inner = <BoxNote m={m} />;
  } else if (m.kind === "handoff") {
    inner = <HandoffMessage m={m} />;
  } else {
    inner = (
      <ReplyMessage m={m} progress={progress} retryable={retryable} answerable={answerable} />
    );
  }

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/noStaticElementInteractions: on a touch screen a tap only reveals the buttons, which are reachable by keyboard anyway
    <div
      className={cls}
      data-id={m.id}
      onClick={touchScreen() ? () => setTapped((v) => !v) : undefined}
    >
      {inner}
    </div>
  );
});

function Fold({
  messages,
  text,
  open,
  onToggle,
  onDelete,
}: {
  messages: ThreadMessage[];
  text: string;
  open: boolean;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const first = messages[0] as ThreadMessage;
  return (
    <div className={`fold-row ${open ? "open" : ""}`}>
      <button type="button" className="fold" onClick={onToggle}>
        <Icon name="chevron" />
        <span className="fold-text">{text}</span>
        <span className="t">{time(first.createdAt)}</span>
      </button>
      <button type="button" className="msg-act" title="Delete conversation" onClick={onDelete}>
        <Icon name="trash" />
      </button>
    </div>
  );
}

/**
 * Window listeners that take files dragged anywhere over the app: the browser would otherwise open a
 * file dropped outside the chat in the app's place.
 */
export function fileDrops(
  attach: (files: FileList) => void,
  setDropping: (on: boolean) => void,
): [string, (e: Event) => void][] {
  const files = (e: DragEvent) => !!e.dataTransfer?.types.includes("Files");
  // Each element the drag enters, it leaves again: once it has left as many as it entered, it's out
  // of the window or given up. Not relatedTarget, which Safari leaves null on every dragleave.
  let depth = 0;
  return [
    [
      "dragenter",
      (e) => {
        if (!files(e as DragEvent)) return;
        depth++;
        setDropping(true);
      },
    ],
    [
      "dragover",
      (e) => {
        if (!files(e as DragEvent)) return;
        e.preventDefault();
        setDropping(true);
      },
    ],
    [
      "dragleave",
      () => {
        depth = Math.max(0, depth - 1);
        if (!depth) setDropping(false);
      },
    ],
    [
      "drop",
      (e) => {
        const list = (e as DragEvent).dataTransfer?.files;
        if (!files(e as DragEvent)) return;
        e.preventDefault();
        depth = 0;
        setDropping(false);
        if (list?.length) attach(list);
      },
    ],
  ];
}

/**
 * Whether the thread follows the newest message after a scroll: any scroll up, however small, stops it
 * (reading back while a reply streams), and only reaching the bottom again starts it.
 */
export function follows(was: boolean, lastTop: number, top: number, below: number): boolean {
  if (below < 4) return true;
  return top < lastTop ? false : was;
}

/**
 * A wheel turned up stops following at once, before the next streamed line pulls it back. Not when
 * the thread can't move up: no scroll would follow to start it again.
 */
export const wheelStops = (deltaY: number, top: number) => deltaY < 0 && top > 0;

/**
 * What the composer says when a send fails. Only the brain saying no means it wasn't posted: with no
 * answer, or a failure on the way, the brain may have posted it before the answer was lost.
 */
export function sendError(err: unknown, connected: boolean): string {
  if (err instanceof ApiError && err.status < 500) return err.message;
  return connected
    ? "It may not have been sent."
    : "Can't reach Hatbot. It may not have been sent.";
}

/** `id`: the chat to show. It's opened here, before loading, so a message asked for is looked for in it. */
export function Chat({ id }: { id: number }) {
  const messages = useStore((s) => s.messages);
  const episodes = useStore((s) => s.episodes);
  const approvals = useStore((s) => s.approvals);
  const questions = useStore((s) => s.questions);
  const chat = useStore(currentChat);
  const chats = useStore((s) => s.conversations);
  // This chat's approvals and tasks' questions, and a line for the rest: each chat's bots ask in their own.
  const waiting = useMemo(
    () =>
      splitWaiting(
        [
          ...Object.values(approvals).filter((a) => a.status === "pending"),
          ...Object.values(questions).filter((q) => q.status === "pending"),
        ].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
        chat,
        chats,
      ),
    [approvals, questions, chat, chats],
  );
  const [unfolded, setUnfolded] = useState<Set<number>>(() => new Set());
  const progress = useStore((s) => s.progress);
  const unread = useStore((s) => s.unread);
  const hasEarlier = useStore((s) => s.hasEarlier);
  const incognito = useStore((s) => s.incognito);
  const name = useStore((s) => chatName(s, currentChat(s)));
  const members = useStore(groupMembers);
  const bots = useStore((s) => s.bots);
  const [error, setError] = useState("");
  // Until the thread has loaded there's nothing to say about it, not even hello.
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const scroller = useRef<HTMLElement>(null);
  const thread = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [far, setFar] = useState(false);
  // Only messages that arrive after the first paint animate in.
  const animateFrom = useRef<number>(Number.POSITIVE_INFINITY);
  const loaded = useRef<Promise<void>>(Promise.resolve());
  // A message to show, from search: ?message=<id>.
  const { path, params } = useRoute();
  const target = Number(params.get("message")) || 0;
  const onSend = useCallback(() => {
    stick.current = true;
  }, []);
  const chatKey = `${id}${incognito ? ":incognito" : ""}`;
  const [dropping, setDropping] = useState(false);
  useEffect(() => {
    const on = fileDrops((list) => attachFiles(chatKey, list), setDropping);
    for (const [type, f] of on) window.addEventListener(type, f);
    return () => {
      for (const [type, f] of on) window.removeEventListener(type, f);
    };
  }, [chatKey]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset the animation on each switch
  useEffect(() => {
    animateFrom.current = Number.POSITIVE_INFINITY;
    stick.current = true;
    void openConversation(id);
    setReady(false);
    setLoadError("");
    loaded.current = loadThread().then(
      () => {
        animateFrom.current = (getState().messages.at(-1)?.id ?? 0) + 1;
        setReady(true);
      },
      (err) => setLoadError(errorText(err)),
    );
  }, [incognito, id, attempt]);

  // Loads back to the message, opens its conversation if it's folded, and scrolls to it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once per message asked for
  useEffect(() => {
    if (!target) return;
    let gone = false;
    void (async () => {
      await loaded.current.catch(() => {});
      for (let i = 0; i < 40 && !gone; i++) {
        const s = getState();
        if (s.messages.some((m) => m.id === target) || !s.hasEarlier) break;
        stick.current = false;
        await loadEarlier();
      }
      if (gone) return;
      const m = getState().messages.find((x) => x.id === target);
      navigate(path, true);
      if (!m) return setError("That message isn't in this chat any more.");
      stick.current = false;
      if (m.episodeId) setUnfolded((s) => new Set(s).add(m.episodeId as number));
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          const el = scroller.current?.querySelector(`[data-id="${target}"]`);
          if (!el) return;
          el.scrollIntoView({ block: "center" });
          el.classList.add("msg-found");
          setTimeout(() => el.classList.remove("msg-found"), 2500);
        }),
      );
    })();
    return () => {
      gone = true;
    };
  }, [target]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });
  // Cards and screenshots load after the messages and grow the thread, and a growing composer or tray
  // shrinks the view; keep following.
  useEffect(() => {
    const el = scroller.current;
    const content = thread.current;
    if (!el || !content) return;
    const ro = new ResizeObserver(() => {
      if (stick.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(content);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // An unread message that has been on screen for a moment, with the window in front, is seen.
  useEffect(() => {
    if (!unread.length) return;
    const since = new Map<number, number>();
    const timer = setInterval(() => {
      const el = scroller.current;
      if (!el || document.visibilityState !== "visible" || !document.hasFocus())
        return since.clear();
      const view = el.getBoundingClientRect();
      const now = Date.now();
      for (const id of unread) {
        const r = el.querySelector(`[data-id="${id}"]`)?.getBoundingClientRect();
        if (r && r.top < view.bottom && r.bottom > view.top) since.set(id, since.get(id) ?? now);
        else since.delete(id);
      }
      const seen = [...since].filter(([, t]) => now - t >= SEEN_AFTER_MS).map(([id]) => id);
      if (seen.length) markSeen(seen);
    }, 500);
    return () => clearInterval(timer);
  }, [unread]);

  const lastTop = useRef(0);
  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const below = el.scrollHeight - el.scrollTop - el.clientHeight;
    stick.current = follows(stick.current, lastTop.current, el.scrollTop, below);
    lastTop.current = el.scrollTop;
    setFar(below > Math.max(400, el.clientHeight));
  };
  const toBottom = () => {
    const el = scroller.current;
    if (!el) return;
    stick.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
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

  const lastReply = messages.findLast(
    (m) => m.role === "assistant" && m.kind !== "command" && m.kind !== "box",
  );
  const retryableId = lastReply?.status === "error" ? lastReply.id : 0;
  // A question's choices stay tappable until anything comes after it.
  const answerableId = messages.at(-1)?.choices?.length ? (messages.at(-1)?.id ?? 0) : 0;
  // A screen reader hears each new reply once it's finished, not every streamed word.
  const said =
    lastReply && lastReply.status !== "streaming" && lastReply.id >= animateFrom.current
      ? spoken(lastReply, botName(getState(), lastReply.botId))
      : "";

  let lastDay = "";
  const now = new Date();
  const dayBefore = (m: ThreadMessage) => {
    const day = dayLabel(m.createdAt, now);
    const show = day !== lastDay;
    lastDay = day;
    return show ? <div className="day">{day}</div> : null;
  };
  let lastSender: string | null = null;
  const senderBefore = (m: ThreadMessage) => {
    // A box's note isn't its bot's words.
    const sender = m.role === "assistant" && m.kind !== "box" ? m.botId : null;
    const show = members && sender && sender !== lastSender && m.kind !== "command";
    lastSender = sender;
    return show ? (
      <div
        className="msg-sender"
        style={bots[sender] ? { color: `var(--bot-${bots[sender].color})` } : undefined}
      >
        {bots[sender]?.name ?? sender}
      </div>
    ) : null;
  };
  const row = (m: ThreadMessage) => (
    <Fragment key={m.id}>
      {dayBefore(m)}
      {senderBefore(m)}
      <Message
        m={m}
        progress={progress[m.id]}
        animate={m.id >= animateFrom.current}
        unread={unread.includes(m.id)}
        retryable={m.id === retryableId}
        answerable={m.id === answerableId}
      />
    </Fragment>
  );
  const toggle = (id: number) =>
    setUnfolded((s) => {
      const next = new Set(s);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  return (
    <>
      <section
        className={`view ${dropping ? "dropping" : ""}`}
        ref={scroller}
        onScroll={onScroll}
        onWheel={(e) => {
          if (wheelStops(e.deltaY, e.currentTarget.scrollTop)) stick.current = false;
        }}
      >
        <div className="chat-scroll">
          <div className="thread" ref={thread}>
            {hasEarlier && (
              <button type="button" className="btn sm ghost load-earlier" onClick={earlier}>
                Earlier messages
              </button>
            )}
            {loadError && !messages.length && (
              <LoadError error={loadError} retry={() => setAttempt((n) => n + 1)} />
            )}
            {ready && !messages.length && (
              <div className="empty">
                {incognito
                  ? `${name} can't see earlier conversations here, and this one is deleted when you leave.`
                  : `Say hello to ${name}.`}
              </div>
            )}
            {threadGroups(messages, episodes).map((g) => {
              if (g.fold === null || g.episodeId === null) return g.messages.map(row);
              const id = g.episodeId;
              const open = unfolded.has(id);
              // A message you haven't seen stays in view.
              const waiting = g.messages.filter((m) => unread.includes(m.id));
              return (
                <Fragment key={`fold-${id}`}>
                  {dayBefore(g.messages[0] as ThreadMessage)}
                  <Fold
                    messages={g.messages}
                    text={g.fold}
                    open={open}
                    onToggle={() => toggle(id)}
                    onDelete={async () => {
                      if (
                        !(await ask({
                          text: `Delete this conversation for good? ${name} forgets it too.`,
                          ok: "Delete",
                        }))
                      )
                        return;
                      setError("");
                      deleteEpisode(id).catch((err) => setError(errorText(err)));
                    }}
                  />
                  {open ? g.messages.map(row) : waiting.map(row)}
                </Fragment>
              );
            })}
          </div>
        </div>
      </section>
      <div className="composer-wrap">
        {far && (
          <button type="button" className="to-bottom" title="Latest messages" onClick={toBottom}>
            <Icon name="down" />
          </button>
        )}
        {(waiting.here.length > 0 || waiting.rest > 0) && (
          <div className="approval-tray">
            {waiting.here.map((a) =>
              "question" in a ? (
                <PendingQuestion
                  key={`q${a.id}`}
                  q={a}
                  links={
                    <button
                      type="button"
                      className="btn sm ghost"
                      onClick={() => navigate(`/tasks/${a.taskId}`)}
                    >
                      Open task
                    </button>
                  }
                />
              ) : (
                <TrayApproval key={a.id} a={a} />
              ),
            )}
            {waiting.rest > 0 && (
              <button
                type="button"
                className="text-link tray-more"
                onClick={() =>
                  navigate(waiting.elsewhere ? chatPath(waiting.elsewhere.id) : "/tasks")
                }
              >
                {waiting.here.length ? `${waiting.rest} more` : waiting.rest} waiting in{" "}
                {waiting.elsewhere ? chatName(getState(), waiting.elsewhere) : "other chats"}
              </button>
            )}
          </div>
        )}
        {error && (
          <div className="form-error" style={{ maxWidth: 760, margin: "0 auto 6px" }}>
            {error}
          </div>
        )}
        <Composer key={chatKey} chat={chatKey} onSend={onSend} />
      </div>
      <div className="sr-only" aria-live="polite">
        {said}
      </div>
    </>
  );
}

export function spoken(m: ThreadMessage, name: string): string {
  const text = plainText(m.text);
  if (!text) return "";
  return `${name}: ${text.length > 400 ? `${text.slice(0, 399)}…` : text}`;
}

const groupMembers = (s: ReturnType<typeof getState>) => {
  const c = currentChat(s);
  return c?.kind === "group" ? c.botIds : null;
};

/** A random id for a send. Not crypto.randomUUID, which needs https, and a LAN address may not have it. */
const randomId = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");

/** Apart from the thread, so typing redraws only this. */
export function Composer({ chat, onSend }: { chat: string; onSend: () => void }) {
  const incognito = useStore((s) => s.incognito);
  const name = useStore((s) => chatName(s, currentChat(s)));
  const members = useStore(groupMembers);
  const bots = useStore((s) => s.bots);
  const [draft, setDraftState] = useState(() => draftText(chat));
  const setDraft = (fn: string | ((d: string) => string)) =>
    setDraftState((d) => {
      const next = typeof fn === "string" ? fn : fn(d);
      saveDraftText(chat, next);
      return next;
    });
  const [pick, setPick] = useState(0);
  const [menuClosed, setMenuClosed] = useState(false);
  const files = useDraftFiles(chat);
  // Uploads finish into their own chat's draft, even after you've gone to another.
  const setFiles = (fn: (f: DraftFile[]) => DraftFile[]) => setDraftFiles(chat, fn);
  const picker = useRef<HTMLInputElement>(null);
  const [sending, setSending] = useState(false);
  // A send whose answer never came: the same message sent again keeps its id, so it's posted once.
  const unsure = useRef<{ what: string; clientId: string } | null>(null);
  const menuId = useId();
  const [error, setError] = useState("");
  const textarea = useRef<HTMLTextAreaElement>(null);
  // While a reply streams, an empty composer's button stops it.
  const replying = useStore((s) => s.messages.some((m) => m.status === "streaming"));
  const canStop = replying && !draft.trim() && !files.length;

  const resize = () => {
    const ta = textarea.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
  };
  // A kept draft can be several lines; sized once, on opening.
  useLayoutEffect(resize, []);
  // Opening a chat puts you in its composer; not on a phone, where that would open the keyboard.
  useEffect(() => {
    if (!touchScreen()) textarea.current?.focus({ preventScroll: true });
  }, []);

  const attach = (list: FileList | File[]) => attachFiles(chat, list);
  const unattach = (key: number) => removeFile(chat, key);
  const uploading = files.some((d) => !d.attachment && !d.error);
  const ready = files.filter((d) => d.attachment);
  // A file that didn't upload holds the message until it's taken off: it would go without it.
  const failed = files.filter((d) => d.error);

  // Incognito keeps nothing, so commands that would outlast it aren't offered.
  const commands = menuClosed
    ? []
    : matchingCommands(draft).filter((c) => !incognito || c.name === "new" || c.name === "stop");
  // One that needs more goes in the composer for you to finish; the rest run at once.
  const choose = (c: (typeof commands)[number]) => {
    if (c.args.startsWith("<")) {
      setDraft(`/${c.name} `);
      textarea.current?.focus();
    } else void send(`/${c.name}`);
  };
  const at = members && !menuClosed ? /(?:^|\s)@([^\s@]*)$/.exec(draft) : null;
  const typed = at?.[1]?.toLowerCase() ?? "";
  const mentionable = at
    ? (members ?? []).filter(
        (id) => id.startsWith(typed) || botName(getState(), id).toLowerCase().startsWith(typed),
      )
    : [];
  const options: Option[] = mentionable.length
    ? mentionable.map((id) => ({
        key: id,
        label: `@${bots[id]?.name ?? id}`,
        desc: bots[id]?.instructions.split("\n")[0] ?? "",
        choose: () => {
          setDraft(`${draft.slice(0, draft.length - typed.length - 1)}@${bots[id]?.name ?? id} `);
          textarea.current?.focus();
        },
      }))
    : commands.map((c) => ({
        key: c.name,
        label: (
          <>
            /{c.name}
            {c.args && <span className="args"> {c.args}</span>}
          </>
        ),
        desc: c.description,
        choose: () => choose(c),
      }));
  const picked = options[Math.min(pick, options.length - 1)];

  const send = async (command?: string) => {
    const text = (command ?? draft).trim();
    if ((!text && !ready.length) || sending || uploading || failed.length) return;
    // Offline it surely won't go, so it isn't tried and stays in the composer.
    if (!navigator.onLine) return setError("You're offline. It wasn't sent.");
    setSending(true);
    setError("");
    onSend();
    // Clear it right away; it comes back if the send fails.
    const sent = files;
    setDraft("");
    setFiles(() => []);
    requestAnimationFrame(resize);
    const ids = ready.map((d) => (d.attachment as Attachment).id);
    const what = JSON.stringify([text, ids]);
    const clientId = unsure.current?.what === what ? unsure.current.clientId : randomId();
    try {
      await sendMessage(text, ids, clientId);
      unsure.current = null;
      for (const d of sent) if (d.preview) URL.revokeObjectURL(d.preview);
    } catch (err) {
      setFiles((f) => (f.length ? f : sent));
      setDraft((d) => d || text);
      requestAnimationFrame(resize);
      // A resend with the same text and files carries the same id, which the brain answers once.
      const refused = err instanceof ApiError && err.status < 500;
      unsure.current = refused ? null : { what, clientId };
      setError(sendError(err, getState().connected));
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      {error && (
        <div className="form-error" style={{ maxWidth: 760, margin: "0 auto 6px" }}>
          {error}
        </div>
      )}
      {options.length > 0 && (
        <div className="command-menu" role="listbox" id={menuId} aria-label="Suggestions">
          {options.map((o) => (
            <button
              key={o.key}
              id={`${menuId}-${o.key}`}
              type="button"
              role="option"
              // The composer keeps the focus and says which is picked.
              tabIndex={-1}
              aria-selected={o === picked}
              className={o === picked ? "on" : ""}
              // Keeps the focus in the composer.
              onMouseDown={(e) => e.preventDefault()}
              onClick={o.choose}
            >
              <span className="name">{o.label}</span>
              <span className="desc">{o.desc}</span>
            </button>
          ))}
        </div>
      )}
      {files.length > 0 && (
        <div className="composer-files">
          {files.map((d) => (
            <span
              key={d.key}
              className={`composer-file ${d.error ? "failed" : d.attachment ? "" : "loading"}`}
              title={d.error ?? d.name}
            >
              {d.preview ? <img src={d.preview} alt="" /> : <Icon name="file" />}
              {!d.preview && <span className="name">{d.name}</span>}
              <button type="button" title="Remove" onClick={() => unattach(d.key)}>
                <Icon name="x" />
              </button>
              {!d.attachment && !d.error && (
                <span className="upload-bar" style={{ width: `${(d.sent ?? 0) * 100}%` }} />
              )}
            </span>
          ))}
        </div>
      )}
      {failed.length > 0 && (
        <div className="form-error composer-error">
          {failed.map((d) => `${d.name}: ${d.error}`).join(" ")}{" "}
          {failed.length > 1 ? "Take them off to send." : "Take it off to send."}
        </div>
      )}
      <div className="composer">
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files) attach(e.target.files);
            e.target.value = "";
          }}
        />
        <button
          type="button"
          className="icon-btn"
          title="Attach files"
          onClick={() => picker.current?.click()}
        >
          <Icon name="clip" />
        </button>
        <textarea
          ref={textarea}
          rows={1}
          // The menu over it: commands after "/", a group's bots after "@". A textarea keeps its own
          // role (combobox isn't allowed on one), which takes all of these but aria-expanded.
          aria-label={`Message ${name}`}
          aria-autocomplete="list"
          aria-controls={options.length > 0 ? menuId : undefined}
          aria-activedescendant={picked ? `${menuId}-${picked.key}` : undefined}
          placeholder={incognito ? `Message ${name} incognito…` : `Message ${name}…`}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setPick(0);
            setMenuClosed(false);
            resize();
          }}
          onPaste={(e) => {
            if (e.clipboardData.files.length) {
              e.preventDefault();
              attach(e.clipboardData.files);
            }
          }}
          onKeyDown={(e) => {
            if (picked && !e.nativeEvent.isComposing) {
              const step = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
              if (step) {
                e.preventDefault();
                const i = options.indexOf(picked);
                return setPick((i + step + options.length) % options.length);
              }
              if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey) {
                e.preventDefault();
                return picked.choose();
              }
              if (e.key === "Escape") return setMenuClosed(true);
            }
            // Up in an empty composer brings back what you last sent, to send again or fix.
            if (e.key === "ArrowUp" && !draft && !e.nativeEvent.isComposing) {
              const last = getState().messages.findLast((m) => m.role === "user" && m.text);
              if (last) {
                e.preventDefault();
                setDraft(last.text);
                requestAnimationFrame(() => {
                  resize();
                  const ta = textarea.current;
                  ta?.setSelectionRange(ta.value.length, ta.value.length);
                });
              }
              return;
            }
            if (e.key === "Escape" && canStop) {
              e.preventDefault();
              return void send("/stop");
            }
            // On a phone's keyboard Enter is a new line; the button sends.
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && !touchScreen()) {
              e.preventDefault();
              void send();
            }
          }}
        />
        {canStop ? (
          <button
            type="button"
            className="icon-btn send"
            title="Stop"
            disabled={sending}
            onClick={() => send("/stop")}
          >
            <Icon name="stop" />
          </button>
        ) : (
          <button
            type="button"
            className="icon-btn send"
            title="Send"
            disabled={(!draft.trim() && !ready.length) || sending || uploading || failed.length > 0}
            onClick={() => send()}
          >
            <Icon name="up" />
          </button>
        )}
      </div>
    </>
  );
}
