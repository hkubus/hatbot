import { MATCH_END, MATCH_START, type SearchResults } from "@hatbot/shared";
import { Fragment, useEffect, useRef, useState } from "react";
import { api, errorText } from "../api";
import { plainText } from "../format";
import { Icon } from "../icons";
import { Link } from "../link";
import { navigate } from "../router";
import { botName, chatName, chatPath, getState, useStore } from "../store";
import { StatusChip } from "../tasks";
import { Group, LinkRow } from "../ui";

const ROUTINE = { schedule: "/schedules", trigger: "/triggers", watcher: "/watchers" } as const;

const day = (iso: string) =>
  new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

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
        (err) => setError(errorText(err)),
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
          <Group title="Chats">
            {results.messages.map((m) => {
              const chat = conversations.find((c) => c.id === m.conversationId);
              const who = m.botId ? botName(getState(), m.botId) : "You";
              return (
                <Link
                  key={m.id}
                  className="row row-link"
                  to={`${chatPath(m.conversationId)}?message=${m.id}`}
                >
                  <div className="txt snippet">
                    <b>{who}:</b> <Snippet text={m.snippet} />
                  </div>
                  <span className="val">
                    {manyChats && chat ? `${chatName(getState(), chat)}, ` : ""}
                    {day(m.createdAt)}
                  </span>
                </Link>
              );
            })}
          </Group>
        )}
        {results && results.tasks.length > 0 && (
          <Group title="Tasks">
            {results.tasks.map((t) => (
              <Link key={t.id} className="row row-link" to={`/tasks/${t.id}`}>
                <div className="txt">
                  <b>{t.title}</b>
                </div>
                <StatusChip status={t.status} />
                <span className="val">{day(t.createdAt)}</span>
              </Link>
            ))}
          </Group>
        )}
        {results && results.memory.length > 0 && (
          <Group title="Memory">
            {results.memory.map((h) => (
              <Link
                key={`${h.path}:${h.line}`}
                className="row row-link"
                to={`/memory?path=${encodeURIComponent(h.path)}`}
              >
                <div className="txt snippet">{plainText(h.text)}</div>
                <span className="val mono">{h.path}</span>
              </Link>
            ))}
          </Group>
        )}
        {results && results.routines.length > 0 && (
          <Group title="Schedules, triggers and watchers">
            {results.routines.map((r) => (
              <LinkRow key={`${r.kind}${r.id}`} to={`${ROUTINE[r.kind]}/${r.id}`} label={r.name}>
                <span className="val">{r.kind[0]?.toUpperCase() + r.kind.slice(1)}</span>
              </LinkRow>
            ))}
          </Group>
        )}
      </div>
    </section>
  );
}
