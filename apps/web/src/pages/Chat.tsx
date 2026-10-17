import {
  API_PREFIX,
  type Approval,
  type Attachment,
  matchingCommands,
  type Source,
  type ThreadMessage,
  threadGroups,
} from "@hatbot/shared";
import {
  createContext,
  Fragment,
  memo,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { ApiError, attachmentUrl } from "../api";
import { Chart, ChartPending } from "../chart";
import { parseChart } from "../chartspec";
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
import { plainText } from "../format";
import { Icon } from "../icons";
import { Link } from "../link";
import { LoadError, loadErrorText } from "../load";
import { splitBlocks } from "../md-blocks";
import { touchScreen } from "../media";
import { negotiationText } from "../negotiations";
import { navigate, useRoute } from "../router";
import {
  botName,
  chatName,
  currentChat,
  deleteEpisode,
  ensureNegotiation,
  ensureSchedule,
  ensureTask,
  getState,
  HATBOT_CHAT,
  loadEarlier,
  loadThread,
  markSeen,
  negotiationOf,
  openConversation,
  retryReply,
  sendMessage,
  useStore,
} from "../store";
import { isActive, PendingApproval, taskLine, tokenText, whenText } from "../tasks";
import { splitWaiting } from "../waiting";

/** How long an unread message stays on screen before it counts as seen. */
const SEEN_AFTER_MS = 1500;

const time = (iso: string) =>
  new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

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

/** Copies `text`; `copied` is true for a moment after. */
function useCopy(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  const copy = async (text: string) => {
    await navigator.clipboard?.writeText(text).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return [copied, copy];
}

/** A code block, with Copy in its corner. */
function CodeBlock({ code, children }: { code: string; children: React.ReactNode }) {
  const [copied, copy] = useCopy();
  return (
    <div className="code-block">
      <pre>{children}</pre>
      <button
        type="button"
        className="msg-act code-copy"
        title="Copy"
        onClick={(e) => {
          e.stopPropagation();
          copy(code.replace(/\n$/, ""));
        }}
      >
        <Icon name={copied ? "check" : "copy"} />
      </button>
    </div>
  );
}

/** Whether the reply is still streaming: a chart block that doesn't parse yet is unfinished, not broken. */
const Streaming = createContext(false);

type Node = { type: string; value?: string; children?: Node[] };
const textOf = (n: Node): string => n.value ?? (n.children ?? []).map(textOf).join("");

/** Where a link goes in the app itself: its path, or null for other sites and the API's files. */
export function appPath(href: string, origin = location.origin): string | null {
  let url: URL;
  try {
    url = new URL(href, origin);
  } catch {
    return null;
  }
  if (url.origin !== origin || url.pathname.startsWith(`${API_PREFIX}/`)) return null;
  return url.pathname + url.search + url.hash;
}

/** Whether a picture is served by Hatbot: the page may load nothing else (web.ts). */
const ownPicture = (src: string, origin = location.origin) => {
  try {
    return new URL(src, origin).origin === origin;
  } catch {
    return false;
  }
};

// Other sites open in a new tab, and the app's own pages in this one; raw HTML in replies is never
// rendered (react-markdown's default).
const MD_COMPONENTS: Components = {
  a: ({ node: _, href, ...props }) => {
    if (href?.startsWith("#")) return <a {...props} href={href} />;
    const to = href ? appPath(href) : null;
    return to ? (
      <Link {...props} to={to} />
    ) : (
      <a {...props} href={href} target="_blank" rel="noreferrer noopener" />
    );
  },
  // A picture from another site would only show broken: it's a link to it instead.
  img: ({ node: _, src, alt }) => {
    if (typeof src !== "string" || !src) return alt || null;
    if (ownPicture(src)) return <img src={src} alt={alt ?? ""} loading="lazy" />;
    return (
      <a href={src} target="_blank" rel="noreferrer noopener">
        {alt || src}
      </a>
    );
  },
  pre: function Pre({ node, children }) {
    const streaming = useContext(Streaming);
    const code = node?.children.find((c) => c.type === "element" && c.tagName === "code");
    const lang =
      code?.type === "element" && Array.isArray(code.properties.className)
        ? String(code.properties.className[0] ?? "").replace(/^language-/, "")
        : "";
    const text = code ? textOf(code as Node) : "";
    if (lang === "chart") {
      const spec = parseChart(text);
      if (spec) return <Chart spec={spec} />;
      if (streaming) return <ChartPending />;
    }
    return <CodeBlock code={text}>{children}</CodeBlock>;
  },
};

const REMARK = [remarkGfm];

const MarkdownBlock = memo(function MarkdownBlock({ text }: { text: string }) {
  return (
    <Markdown remarkPlugins={REMARK} components={MD_COMPONENTS}>
      {text}
    </Markdown>
  );
});

export const AssistantBody = memo(function AssistantBody({
  text,
  streaming = false,
}: {
  text: string;
  streaming?: boolean;
}) {
  return (
    <div className="md">
      <Streaming.Provider value={streaming}>
        {/* While it streams, only the block still growing is parsed again. */}
        {streaming ? (
          splitBlocks(text).map((block, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: blocks only grow at the end
            <MarkdownBlock key={i} text={block} />
          ))
        ) : (
          <MarkdownBlock text={text} />
        )}
      </Streaming.Provider>
    </div>
  );
});

/** Time, then actions that show on hover (or a tap on touch screens). */
function Meta({
  m,
  copy,
  open,
  retry,
}: {
  m: ThreadMessage;
  copy?: string;
  open?: { to: string; label: string };
  /** An errored reply: its bot writes it again. */
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

/** A task, as a message: what it's doing while it runs, then how it ended. */
function TaskMessage({ m, taskId }: { m: ThreadMessage; taskId: number }) {
  const task = useStore((s) => s.tasks[taskId]);
  const progress = useStore((s) => s.taskProgress[taskId]);
  const control = useStore((s) => s.desktop?.control);
  useEffect(() => ensureTask(taskId), [taskId]);
  // Until it loads (it's fetched again after a reconnect if it failed), the card's own line.
  if (!task)
    return (
      <>
        <div className="body">
          <div className="muted card-pending">{plainText(m.text) || `Task #${taskId}`}</div>
        </div>
        <Meta m={m} open={{ to: `/tasks/${taskId}`, label: "Open task" }} />
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

/** A negotiation under the reply that started it: the listing, and where it stands. */
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

/**
 * Hatbot's reply, with the task it started (if any) working under it. Once the task finishes or fails,
 * its bot writes the reply again to say what came of it; if it doesn't, the task's result shows in the
 * reply's place. A cancelled task leaves the reply.
 */
function ReplyMessage({
  m,
  progress,
  retryable,
}: {
  m: ThreadMessage;
  progress?: string;
  retryable: boolean;
}) {
  const task = useStore((s) => (m.taskId ? s.tasks[m.taskId] : undefined));
  const used = useStore((s) => s.usage[m.id]);
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
        {m.negotiationId && <NegotiationResult id={m.negotiationId} />}
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
              : m.taskId
                ? { to: `/tasks/${m.taskId}`, label: "Open task" }
                : undefined
          }
          retry={retryable && m.status === "error" ? () => retryReply(m) : undefined}
        />
      )}
    </>
  );
}

/** An approval waiting for you, in the tray above the composer: what it asks, and where it came from. */
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

/** A schedule Hatbot made, as one line. */
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
      </div>
      <Meta
        m={m}
        copy={s ? s.prompt : undefined}
        open={s ? { to: `/schedules/${s.id}`, label: "Open schedule" } : undefined}
      />
    </>
  );
}

/** A message's files: pictures you can open, the rest to open or save. */
/** The pages a reply cites, in a line. */
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
            <img src={attachmentUrl(a.id)} alt={a.name} loading="lazy" />
          </a>
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

/** A line in the menu over the composer: a command, or in a group a bot to @mention. */
type Option = { key: string; label: React.ReactNode; desc: string; choose: () => void };

// Memoized: while a reply streams only its own message redraws, not the whole thread's markdown.
export const Message = memo(function Message({
  m,
  progress,
  animate,
  unread,
  retryable = false,
}: {
  m: ThreadMessage;
  progress?: string;
  animate: boolean;
  /** The latest reply, errored: it can be tried again. */
  retryable?: boolean;
  /** Sent or edited since you last saw it. */
  unread: boolean;
}) {
  // Touch screens have no hover: a tap shows the message's actions.
  const [tapped, setTapped] = useState(false);
  // What came of a command: a quiet line rather than a message.
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
  } else {
    inner = <ReplyMessage m={m} progress={progress} retryable={retryable} />;
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

/** A finished conversation, folded up under its recap. */
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
  return [
    [
      "dragover",
      (e) => {
        if (!files(e as DragEvent)) return;
        e.preventDefault();
        setDropping(true);
      },
    ],
    // Out of the window, or the drag given up.
    ["dragleave", (e) => !(e as DragEvent).relatedTarget && setDropping(false)],
    [
      "drop",
      (e) => {
        const list = (e as DragEvent).dataTransfer?.files;
        if (!files(e as DragEvent)) return;
        e.preventDefault();
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

/** `id`: the chat to show. It's opened here, before loading, so a message asked for is looked for in it. */
export function Chat({ id }: { id: number }) {
  const messages = useStore((s) => s.messages);
  const episodes = useStore((s) => s.episodes);
  const approvals = useStore((s) => s.approvals);
  const chat = useStore(currentChat);
  const chats = useStore((s) => s.conversations);
  // This chat's approvals, and a line for the rest: each chat's bots ask in their own.
  const waiting = useMemo(
    () =>
      splitWaiting(
        Object.values(approvals)
          .filter((a) => a.status === "pending")
          .sort((a, b) => a.id - b.id),
        chat,
        chats,
      ),
    [approvals, chat, chats],
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
  // Scrolled well up: an arrow above the composer goes back down.
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
  // Files dropped anywhere in the window go into the composer.
  const [dropping, setDropping] = useState(false);
  useEffect(() => {
    const on = fileDrops((list) => attachFiles(chatKey, list), setDropping);
    for (const [type, f] of on) window.addEventListener(type, f);
    return () => {
      for (const [type, f] of on) window.removeEventListener(type, f);
    };
  }, [chatKey]);

  // Opening the chat, or going to or from incognito, loads its conversation in the store.
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
      (err) => setLoadError(loadErrorText(err)),
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

  // Follow the conversation while the view is at the bottom.
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

  // Only the latest reply can be tried again, and only if it errored.
  const lastReply = messages.findLast((m) => m.role === "assistant" && m.kind !== "command");
  const retryableId = lastReply?.status === "error" ? lastReply.id : 0;
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
  // In a group, the bot's name above each run of its messages.
  let lastSender: string | null = null;
  const senderBefore = (m: ThreadMessage) => {
    const sender = m.role === "assistant" ? m.botId : null;
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
                      deleteEpisode(id).catch((err) =>
                        setError(err instanceof ApiError ? err.message : "Couldn't reach Hatbot."),
                      );
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
            {waiting.here.map((a) => (
              <TrayApproval key={a.id} a={a} />
            ))}
            {waiting.rest > 0 && (
              <button
                type="button"
                className="tray-more"
                onClick={() =>
                  navigate(
                    !waiting.elsewhere
                      ? "/tasks"
                      : waiting.elsewhere.id === HATBOT_CHAT
                        ? "/"
                        : `/chat/${waiting.elsewhere.id}`,
                  )
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

/** A reply as a screen reader says it: who, then its text without Markdown's marks, cut short. */
export function spoken(m: ThreadMessage, name: string): string {
  const text = m.text
    .replace(/[*_`#>|~]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  return `${name}: ${text.length > 400 ? `${text.slice(0, 399)}…` : text}`;
}

/** A group's bots, for the names above their messages and @ in the composer. */
const groupMembers = (s: ReturnType<typeof getState>) => {
  const c = currentChat(s);
  return c?.kind === "group" ? c.botIds : null;
};

/** A random id for a send. Not crypto.randomUUID, which needs https, and a LAN address may not have it. */
const randomId = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");

/** What you're writing, its files and the menu over it; apart from the thread, so typing redraws only this. */
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
  // The command list under "/…": which one is picked, and whether Escape closed it.
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
  // In a group, "@" at the end offers its bots.
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
      // The brain said no: it wasn't posted. No answer, or a failure on the way: it may have been.
      const refused = err instanceof ApiError && err.status < 500;
      unsure.current = refused ? null : { what, clientId };
      setError(
        refused
          ? err.message
          : !navigator.onLine
            ? "You're offline. It wasn't sent."
            : getState().connected
              ? "It may not have been sent. Sending it again won't send it twice."
              : "Can't reach Hatbot. It wasn't sent.",
      );
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
