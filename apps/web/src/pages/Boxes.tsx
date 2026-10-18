// Boxes (PLAN.md §21): the small web apps your bots made, and one as large as the window allows, its
// page sandboxed on an opaque origin, with what it saves going through the app to the brain.
import type { Box, BoxAnswer, BoxDetail, BoxPage as BoxSource } from "@hatbot/shared";
import { useEffect, useRef, useState } from "react";
import { useAction } from "../action";
import { ApiError, api, errorText } from "../api";
import { ask } from "../confirm";
import { NoForm } from "../form";
import { timeOrDay } from "../format";
import { LoadError } from "../load";
import { useMedia } from "../media";
import { navigate } from "../router";
import { loadBoxes, putBox, useStore } from "../store";
import { useTheme } from "../theme";
import { BackHead, Group, LinkRow, Select } from "../ui";

export function BoxesPage() {
  const boxes = useStore((s) => s.boxes);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt is Retry
  useEffect(() => {
    setError("");
    loadBoxes().then(
      () => setLoaded(true),
      (err) => setError(errorText(err)),
    );
  }, [attempt]);

  const list = Object.values(boxes)
    .filter((b): b is Box => !!b)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id - a.id);
  return (
    <section className="view">
      <div className="page narrow">
        {error && <LoadError error={error} retry={() => setAttempt((n) => n + 1)} />}
        {loaded && (
          <Group>
            {list.map((b) => (
              <LinkRow key={b.id} to={`/boxes/${b.id}`} label={b.title}>
                <span className="val">{timeOrDay(b.updatedAt)}</span>
              </LinkRow>
            ))}
            {!list.length && (
              <div className="row">
                <span className="muted">
                  No boxes yet. Ask Hatbot for a tracker, a calculator or a planner to keep.
                </span>
              </div>
            )}
          </Group>
        )}
      </div>
    </section>
  );
}

export function BoxPage({ id }: { id: number }) {
  const gone = useStore((s) => s.boxes[id] === null);
  const changed = useStore((s) => s.boxes[id]?.updatedAt);
  const [detail, setDetail] = useState<BoxDetail | null>(null);
  const [missing, setMissing] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [attempt, setAttempt] = useState(0);
  /** The version showing; null for the current one, which follows the bot's changes. */
  const [picked, setPicked] = useState<number | null>(null);
  const [code, setCode] = useState(false);
  const { busy, error, run } = useAction();
  // What was read last: the box.updated it puts in the store needn't read it again.
  const seen = useRef("");

  const show = (d: BoxDetail) => {
    seen.current = d.updatedAt;
    setDetail(d);
    const { versions: _, ...box } = d;
    putBox(box);
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: a change, or Retry, reads it again
  useEffect(() => {
    if (changed && changed === seen.current) return;
    let stale = false;
    setLoadError("");
    api<BoxDetail>(`/boxes/${id}`).then(
      (d) => !stale && show(d),
      (err) => {
        if (stale) return;
        if (err instanceof ApiError && err.status === 404) setMissing(true);
        else setLoadError(errorText(err));
      },
    );
    return () => {
      stale = true;
    };
  }, [id, changed, attempt]);

  if (missing || gone || !detail)
    return (
      <NoForm
        error={loadError}
        missing={missing || gone ? "This box was deleted." : ""}
        retry={() => setAttempt((n) => n + 1)}
        back={{ label: "Boxes", to: "/boxes" }}
      />
    );

  const version = picked ?? detail.version;
  const remove = async () => {
    if (
      !(await ask({
        text: "Delete this box? Every version and what it saved go with it.",
        ok: "Delete",
      }))
    )
      return;
    await run(async () => {
      await api(`/boxes/${id}`, { method: "DELETE" });
      navigate("/boxes", true);
    });
  };
  const restore = () =>
    run(async () => {
      show(await api<BoxDetail>(`/boxes/${id}/revert`, { body: { version } }));
      setPicked(null);
    });
  return (
    <section className="view">
      <div className="page box-page">
        <BackHead to="/boxes" label="Boxes">
          {detail.versions.length > 1 && (
            <Select
              label="Version"
              className="field"
              value={String(version)}
              options={[...detail.versions]
                .reverse()
                .map((v) => [String(v.n), `Version ${v.n}, ${timeOrDay(v.createdAt)}`] as const)}
              onChange={(v) => setPicked(Number(v) === detail.version ? null : Number(v))}
            />
          )}
          {version !== detail.version && (
            <button type="button" className="btn sm" disabled={busy} onClick={restore}>
              Restore
            </button>
          )}
          <button type="button" className="btn sm" onClick={() => setCode((c) => !c)}>
            {code ? "Page" : "Code"}
          </button>
          <button type="button" className="btn sm danger-text" disabled={busy} onClick={remove}>
            Delete
          </button>
        </BackHead>
        {error && <div className="form-error">{error}</div>}
        {code ? (
          <BoxCode id={id} version={version} />
        ) : (
          <BoxFrame id={id} version={version} title={detail.title} />
        )}
      </div>
    </section>
  );
}

/** A version's page, as its source, read-only. */
function BoxCode({ id, version }: { id: number; version: number }) {
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt is Retry
  useEffect(() => {
    let stale = false;
    setError("");
    api<BoxSource>(`/boxes/${id}/versions/${version}`).then(
      (p) => !stale && setHtml(p.html),
      (err) => !stale && setError(errorText(err)),
    );
    return () => {
      stale = true;
    };
  }, [id, version, attempt]);
  if (error) return <LoadError error={error} retry={() => setAttempt((n) => n + 1)} />;
  return <pre className="box-code">{html}</pre>;
}

const SANDBOX =
  "allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads";

/**
 * The box's page at the signed address the brain gives (PLAN.md §21.1), and the other end of
 * hatbox.store: the app answers its frame's page and nothing else, and stops once the frame has left
 * that page, which then doesn't show under Hatbot's toolbar either.
 */
function BoxFrame({ id, version, title }: { id: number; version: number; title: string }) {
  const theme = useTheme();
  const systemDark = useMedia("(prefers-color-scheme: dark)");
  const dark = theme === "dark" || (theme === "system" && systemDark);
  const darkNow = useRef(dark);
  darkNow.current = dark;
  const frame = useRef<HTMLIFrameElement>(null);
  const loads = useRef(0);
  const [url, setUrl] = useState("");
  const [left, setLeft] = useState(false);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);

  // A new address for each version and each Reload; the theme changes by message, keeping the page.
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt is Reload
  useEffect(() => {
    let stale = false;
    setError("");
    api<{ url: string }>(`/boxes/${id}/open`, { body: { version, dark: darkNow.current } }).then(
      (r) => {
        if (stale) return;
        loads.current = 0;
        setLeft(false);
        setUrl(r.url);
      },
      (err) => !stale && setError(errorText(err)),
    );
    return () => {
      stale = true;
    };
  }, [id, version, attempt]);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const w = frame.current?.contentWindow;
      const d = e.data as { hatbox?: unknown; op?: unknown; key?: unknown; value?: unknown };
      // The page's origin is opaque. A second load means the frame went somewhere else.
      if (!w || e.source !== w || e.origin !== "null" || loads.current > 1) return;
      if (!d || typeof d.hatbox !== "number" || d.hatbox < 1) return;
      const reply = (answer: object) => {
        if (loads.current <= 1) w.postMessage({ hatbox: d.hatbox, ...answer }, "*");
      };
      api<BoxAnswer>(`/boxes/${id}/store`, { body: { op: d.op, key: d.key, value: d.value } }).then(
        (a) => reply({ value: a.value }),
        (err) => reply({ error: errorText(err) }),
      );
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [id]);

  useEffect(() => {
    if (loads.current === 1) frame.current?.contentWindow?.postMessage({ hatbox: 0, dark }, "*");
  }, [dark]);

  if (error) return <LoadError error={error} retry={() => setAttempt((n) => n + 1)} />;
  if (left)
    return (
      <div className="load-error">
        This box left its page.
        <button type="button" className="btn sm" onClick={() => setAttempt((n) => n + 1)}>
          Reload
        </button>
      </div>
    );
  if (!url) return null;
  return (
    <iframe
      key={url}
      ref={frame}
      className="box-frame"
      src={url}
      title={title}
      sandbox={SANDBOX}
      referrerPolicy="no-referrer"
      onLoad={() => {
        loads.current += 1;
        if (loads.current > 1) setLeft(true);
        // The theme may have changed while the page loaded.
        else frame.current?.contentWindow?.postMessage({ hatbox: 0, dark: darkNow.current }, "*");
      }}
    />
  );
}
