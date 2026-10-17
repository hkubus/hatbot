// Search: chats, tasks, memory, and schedules, triggers and watchers, as you type.
import { MATCH_END, MATCH_START, type SearchResults } from "@hatbot/shared";
import { Fragment, useEffect, useRef, useState } from "react";
import { ApiError, api } from "../api";
import { plainText } from "../format";
import { Icon } from "../icons";
import { navigate } from "../router";
import { botName, chatName, getState, HATBOT_CHAT, useStore } from "../store";
import { StatusChip } from "../tasks";

const ROUTINE = { schedule: "/schedules", trigger: "/triggers", watcher: "/watchers" } as const;

const chatPath = (id: number) => (id === HATBOT_CHAT ? "/" : `/chat/${id}`);
const day = (iso: string) =>
  new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

/** A snippet with its matched words highlighted, without its Markdown. */
function Snippet({ text: markdown }: { text: string }) {
  const text = plainText(markdown);
  // Keyed by where each piece starts in the text.
  const pieces: { at: number; text: string; hit: boolean }[] = [];
  const re = new RegExp(`${MATCH_START}([^${MATCH_END}]*)${MATCH_END}`, "g");
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) pieces.push({ at: last, text: text.slice(last, m.index), hit: false });
    pieces.push({ at: m.index, text: m[1] ?? "", hit: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) pieces.push({ at: last, text: text.slice(last), hit: false });
  return (
    <>
      {pieces.map((p) =>
        p.hit ? <mark key={p.at}>{p.text}</mark> : <Fragment key={p.at}>{p.text}</Fragment>,
      )}
    </>
  );
}

export function Search({ query }: { query: string }) {
  const [draft, setDraft] = useState(query);
  const [results, setResults] = useState<SearchResults | null>(null);
  const [error, setError] = useState("");
  const conversations = useStore((s) => s.conversations);
  const manyChats = conversations.length > 1;
  const input = useRef<HTMLInputElement>(null);
  const latest = useRef(query);

  useEffect(() => input.current?.focus(), []);
  // The address keeps the query, so Back returns to these results.
  useEffect(() => {
    const q = draft.trim();
    latest.current = q;
    const timer = setTimeout(() => {
      navigate(q ? `/search?q=${encodeURIComponent(q)}` : "/search", true);
      if (!q) return setResults(null);
      api<SearchResults>(`/search?q=${encodeURIComponent(q)}`).then(
        (r) => {
          setError("");
          // An answer to what you typed before arrives late: the newer one wins.
          if (r.query === latest.current) setResults(r);
        },
        (err) => setError(err instanceof ApiError ? err.message : "Couldn't reach Hatbot."),
      );
    }, 200);
    return () => clearTimeout(timer);
  }, [draft]);

  const nothing =
    results &&
    !results.messages.length &&
    !results.tasks.length &&
    !results.memory.length &&
    !results.routines.length;

  return (
    <section className="view">
      <div className="page">
        <div className="search-box">
          <Icon name="search" />
          <input
            ref={input}
            className="field"
            type="search"
            aria-label="Search"
            value={draft}
            placeholder="Search chats, tasks and memory"
            onChange={(e) => setDraft(e.target.value)}
          />
        </div>
        {error && <div className="form-error">{error}</div>}
        {nothing && <div className="empty">Nothing matches “{results.query}”.</div>}
        {results && results.messages.length > 0 && (
          <section className="group">
            <h2>Chats</h2>
            <div className="group-box">
              {results.messages.map((m) => {
                const chat = conversations.find((c) => c.id === m.conversationId);
                const who = m.botId ? botName(getState(), m.botId) : "You";
                return (
                  <div className="row" key={m.id}>
                    <button
                      type="button"
                      className="row-main"
                      onClick={() => navigate(`${chatPath(m.conversationId)}?message=${m.id}`)}
                    >
                      <div className="txt snippet">
                        <b>{who}:</b> <Snippet text={m.snippet} />
                      </div>
                      <span className="val">
                        {manyChats && chat ? `${chatName(getState(), chat)}, ` : ""}
                        {day(m.createdAt)}
                      </span>
                    </button>
                  </div>
                );
              })}
            </div>
          </section>
        )}
        {results && results.tasks.length > 0 && (
          <section className="group">
            <h2>Tasks</h2>
            <div className="group-box">
              {results.tasks.map((t) => (
                <div className="row" key={t.id}>
                  <button
                    type="button"
                    className="row-main"
                    onClick={() => navigate(`/tasks/${t.id}`)}
                  >
                    <div className="txt">
                      <b>{t.title}</b>
                    </div>
                    <StatusChip status={t.status} />
                    <span className="val">{day(t.createdAt)}</span>
                  </button>
                </div>
              ))}
            </div>
          </section>
        )}
        {results && results.memory.length > 0 && (
          <section className="group">
            <h2>Memory</h2>
            <div className="group-box">
              {results.memory.map((h) => (
                <div className="row" key={`${h.path}:${h.line}`}>
                  <button
                    type="button"
                    className="row-main"
                    onClick={() => navigate(`/memory?path=${encodeURIComponent(h.path)}`)}
                  >
                    <div className="txt snippet">{plainText(h.text)}</div>
                    <span className="val mono">{h.path}</span>
                  </button>
                </div>
              ))}
            </div>
          </section>
        )}
        {results && results.routines.length > 0 && (
          <section className="group">
            <h2>Schedules, triggers and watchers</h2>
            <div className="group-box">
              {results.routines.map((r) => (
                <div className="row" key={`${r.kind}${r.id}`}>
                  <button
                    type="button"
                    className="row-main"
                    onClick={() => navigate(`${ROUTINE[r.kind]}/${r.id}`)}
                  >
                    <div className="txt">
                      <b>{r.name}</b>
                    </div>
                    <span className="val">{r.kind[0]?.toUpperCase() + r.kind.slice(1)}</span>
                    <Icon name="chevron" className="chev" />
                  </button>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </section>
  );
}
