import type { ThreadMessage } from "@hatbot/shared";
import { Fragment, memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Icon } from "../icons";
import { getState, loadEarlier, loadThread, sendMessage, setPaused, useStore } from "../store";

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

function Message({
  m,
  progress,
  animate,
}: {
  m: ThreadMessage;
  progress?: string;
  animate: boolean;
}) {
  if (m.role === "user") {
    return (
      <div className={`msg user ${animate ? "new" : ""}`}>
        <div className="bubble">{m.text}</div>
        <span className="time">{time(m.createdAt)}</span>
      </div>
    );
  }
  const streaming = m.status === "streaming";
  const note = progress?.trim().split("\n").filter(Boolean).at(-1);
  return (
    <div className={`msg ${animate ? "new" : ""}`}>
      <div className="body">
        {m.text && <AssistantBody text={m.text} />}
        {streaming && !m.text && (
          <div className="typing">
            <span />
            <span />
            <span />
          </div>
        )}
        {streaming && note && <div className="progress-note">{note}</div>}
      </div>
      {!streaming && <span className="time">{time(m.createdAt)}</span>}
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
          <div className="thread">
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
