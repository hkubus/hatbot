// Schedules & Triggers (PLAN.md §10.3): see, pause and edit what runs on its own.
import {
  describeCron,
  type Schedule,
  type Task,
  type Trigger,
  type TriggerWithSecret,
} from "@hatbot/shared";
import { useEffect, useState } from "react";
import { ApiError, api } from "../api";
import { Icon } from "../icons";
import { navigate } from "../router";
import {
  loadSchedules,
  loadTasks,
  putSchedule,
  putTrigger,
  saveSchedule,
  useStore,
} from "../store";
import { Switch } from "../switch";
import { StatusChip, whenText } from "../tasks";

const KIND = { webhook: "Webhook", kuma: "Uptime Kuma" } as const;
const KUMA_PROMPT =
  "Find out why it's down. If a restart is likely to fix it, restart the service or guest once and check that it's back. Don't change configuration or delete anything. Tell me what was wrong, what you did, and whether it's working now.";
/** A trigger just made, so its page can show the secret after the route changes to its id. */
let fresh: TriggerWithSecret | null = null;

const stamp = (iso: string) =>
  new Date(iso).toLocaleString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
const errorText = (err: unknown) =>
  err instanceof ApiError ? err.message : "Couldn't reach Hatbot.";

/** The page for /schedules, /schedules/:id, /triggers/:id, and their /new forms. */
export function SchedulesView({ path, params }: { path: string; params: URLSearchParams }) {
  const m = /^\/(schedules|triggers)\/(new|\d+)$/.exec(path);
  if (!m) return <List />;
  const id = m[2] === "new" ? null : Number(m[2]);
  return m[1] === "schedules" ? (
    <ScheduleEdit key={path} id={id} />
  ) : (
    <TriggerEdit key={path} id={id} kind={params.get("kind") === "kuma" ? "kuma" : "webhook"} />
  );
}

function List() {
  const [ids, setIds] = useState<{ schedules: number[]; triggers: number[] } | null>(null);
  const [error, setError] = useState("");
  const schedules = useStore((s) => s.schedules);
  const triggers = useStore((s) => s.triggers);

  useEffect(() => {
    loadSchedules().then(setIds, (err) => setError(errorText(err)));
  }, []);

  const shownSchedules = Object.values(schedules)
    .filter((s): s is Schedule => Boolean(s))
    .sort((a, b) => a.name.localeCompare(b.name));
  const shownTriggers = Object.values(triggers)
    .filter((t): t is Trigger => Boolean(t))
    .sort((a, b) => a.name.localeCompare(b.name));
  const toggleTrigger = (t: Trigger, enabled: boolean) =>
    api<Trigger>(`/triggers/${t.id}`, { method: "PATCH", body: { enabled } }).then(
      putTrigger,
      (err) => setError(errorText(err)),
    );

  return (
    <section className="view">
      <div className="page">
        <div className="page-head">
          <span className="spacer" />
          <button type="button" className="btn" onClick={() => navigate("/schedules/new")}>
            <Icon name="plus" />
            Schedule
          </button>
          <button type="button" className="btn" onClick={() => navigate("/triggers/new")}>
            <Icon name="plus" />
            Trigger
          </button>
        </div>
        {error && <div className="form-error">{error}</div>}
        {ids && (
          <>
            <section className="group">
              <h2>Schedules</h2>
              <div className="group-box">
                {shownSchedules.map((s) => (
                  <div className="row" key={s.id}>
                    <button
                      type="button"
                      className="row-main"
                      onClick={() => navigate(`/schedules/${s.id}`)}
                    >
                      <div className="txt">
                        <b>{s.name}</b>
                      </div>
                      <span className="val">{s.enabled ? whenText(s) : "Off"}</span>
                    </button>
                    <Switch
                      on={s.enabled}
                      onChange={(enabled) =>
                        saveSchedule(s.id, { enabled }).catch((err) => setError(errorText(err)))
                      }
                    />
                    <Icon name="chevron" className="chev" />
                  </div>
                ))}
                {!shownSchedules.length && (
                  <div className="row">
                    <span className="muted">None yet. Ask Hatbot in chat, or add one here.</span>
                  </div>
                )}
              </div>
            </section>
            <section className="group">
              <h2>Triggers</h2>
              <div className="group-box">
                {shownTriggers.map((t) => (
                  <div className="row" key={t.id}>
                    <button
                      type="button"
                      className="row-main"
                      onClick={() => navigate(`/triggers/${t.id}`)}
                    >
                      <div className="txt">
                        <b>{t.name}</b>
                      </div>
                      <span className="val">{t.enabled ? KIND[t.kind] : "Off"}</span>
                    </button>
                    <Switch on={t.enabled} onChange={(enabled) => toggleTrigger(t, enabled)} />
                    <Icon name="chevron" className="chev" />
                  </div>
                ))}
                {!shownTriggers.length && (
                  <div className="row">
                    <span className="muted">None yet.</span>
                  </div>
                )}
              </div>
            </section>
          </>
        )}
      </div>
    </section>
  );
}

/** The runs a schedule or trigger started. */
function Runs({ filter }: { filter: { scheduleId: number } | { triggerId: number } }) {
  const [ids, setIds] = useState<number[] | null>(null);
  const tasks = useStore((s) => s.tasks);
  const key = JSON.stringify(filter);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for `filter`
  useEffect(() => {
    loadTasks(filter).then(setIds, () => setIds([]));
  }, [key]);
  // Runs that start while the page is open show up too.
  const shown = Object.values(tasks)
    .filter(
      (t: Task) =>
        !t.parentId &&
        ("scheduleId" in filter
          ? t.scheduleId === filter.scheduleId
          : t.triggerId === filter.triggerId),
    )
    .sort((a, b) => b.id - a.id)
    .slice(0, 20);
  if (!ids) return null;
  return (
    <div className="panel">
      <h3 className="section-title">Runs</h3>
      {!shown.length ? (
        <div className="muted">Hasn't run yet.</div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <tbody>
              {shown.map((t) => (
                <tr key={t.id} onClick={() => navigate(`/tasks/${t.id}`)}>
                  <td className="wrap">{t.summary ?? t.title}</td>
                  <td>
                    <StatusChip status={t.status} />
                  </td>
                  <td className="muted">{stamp(t.startedAt ?? t.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** datetime-local's value for an ISO time, in this browser's time zone. */
const localInput = (iso: string) => {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

function ScheduleEdit({ id }: { id: number | null }) {
  const stored = useStore((s) => (id === null ? undefined : s.schedules[id]));
  const [form, setForm] = useState<{
    name: string;
    repeat: boolean;
    cron: string;
    at: string;
    prompt: string;
  } | null>(id === null ? { name: "", repeat: true, cron: "0 8 * * *", at: "", prompt: "" } : null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (id !== null && stored === undefined)
      loadSchedules().catch((err) => setError(errorText(err)));
  }, [id, stored]);
  useEffect(() => {
    if (stored && !form)
      setForm({
        name: stored.name,
        repeat: Boolean(stored.cron),
        cron: stored.cron ?? "0 8 * * *",
        at: stored.runAt ? localInput(stored.runAt) : "",
        prompt: stored.prompt,
      });
  }, [stored, form]);

  if (stored === null) return <div className="empty">This schedule doesn't exist.</div>;
  if (!form) return <section className="view" />;

  const set = (patch: Partial<typeof form>) => setForm({ ...form, ...patch });
  const when = form.repeat ? { cron: form.cron.trim() } : { at: form.at };
  const changed =
    !stored ||
    form.name !== stored.name ||
    form.prompt !== stored.prompt ||
    (form.repeat
      ? form.cron.trim() !== stored.cron
      : !stored.runAt || form.at !== localInput(stored.runAt));
  const described = form.repeat ? describeCron(form.cron.trim()) : "";

  const save = async () => {
    setBusy(true);
    setError("");
    try {
      if (stored) {
        await saveSchedule(stored.id, {
          name: form.name,
          prompt: form.prompt,
          ...when,
          ...(!stored.enabled && !stored.cron ? { enabled: true } : {}),
        });
      } else {
        const s = await api<Schedule>("/schedules", {
          body: { name: form.name, prompt: form.prompt, ...when },
        });
        putSchedule(s);
        navigate(`/schedules/${s.id}`, true);
      }
    } catch (err) {
      setError(errorText(err));
    }
    setBusy(false);
  };
  const remove = async () => {
    if (!stored || !confirm(`Delete "${stored.name}"? Its past runs stay in Tasks.`)) return;
    try {
      await api(`/schedules/${stored.id}`, { method: "DELETE" });
      navigate("/schedules");
    } catch (err) {
      setError(errorText(err));
    }
  };
  const runNow = async () => {
    if (!stored) return;
    try {
      const task = await api<Task>(`/schedules/${stored.id}/run`, { body: {} });
      navigate(`/tasks/${task.id}`);
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <section className="view">
      <div className="page narrow">
        <div className="page-head">
          <button
            type="button"
            className="btn sm ghost back"
            onClick={() => navigate("/schedules")}
          >
            <Icon name="chevron" />
            Schedules
          </button>
          <span className="spacer" />
          {stored && (
            <>
              <button type="button" className="btn sm" onClick={runNow}>
                <Icon name="play" />
                Run now
              </button>
              <button type="button" className="btn sm danger-text" onClick={remove}>
                Delete
              </button>
            </>
          )}
        </div>

        <div className="panel form">
          <label>
            <span className="label">Name</span>
            <input
              className="field"
              value={form.name}
              maxLength={80}
              placeholder="Framework 16 stock check"
              onChange={(e) => set({ name: e.target.value })}
            />
          </label>
          <div className="form-row">
            <span className="label">When</span>
            <div className="seg">
              <button
                type="button"
                className={form.repeat ? "active" : ""}
                onClick={() => set({ repeat: true })}
              >
                Repeats
              </button>
              <button
                type="button"
                className={form.repeat ? "" : "active"}
                onClick={() => set({ repeat: false })}
              >
                Once
              </button>
            </div>
          </div>
          {form.repeat ? (
            <label>
              <span className="label">Cron, in Hatbot's time zone</span>
              <input
                className="field mono"
                value={form.cron}
                spellCheck={false}
                onChange={(e) => set({ cron: e.target.value })}
              />
              <span className="muted hint">
                {described !== form.cron.trim() ? described : "minute hour day month weekday"}
              </span>
            </label>
          ) : (
            <label>
              <span className="label">At</span>
              <input
                className="field"
                type="datetime-local"
                value={form.at}
                onChange={(e) => set({ at: e.target.value })}
              />
            </label>
          )}
          <label>
            <span className="label">What to do</span>
            <textarea
              className="field"
              rows={5}
              maxLength={4000}
              value={form.prompt}
              placeholder="Check whether the Framework 16 is in stock in the EU store. Tell me only if it is."
              onChange={(e) => set({ prompt: e.target.value })}
            />
          </label>
          {stored && (
            <dl className="kv">
              <dt>Next run</dt>
              <dd>{stored.enabled && stored.nextRunAt ? stamp(stored.nextRunAt) : "Off"}</dd>
            </dl>
          )}
          {error && <div className="form-error">{error}</div>}
          <div className="form-actions">
            <button
              type="button"
              className="btn accent"
              disabled={busy || !changed || !form.name.trim() || !form.prompt.trim()}
              onClick={save}
            >
              {stored ? "Save" : "Create"}
            </button>
          </div>
        </div>

        {stored && <Runs filter={{ scheduleId: stored.id }} />}
      </div>
    </section>
  );
}

/** How to point the sender at a trigger, with its secret. Shown once, after it's made or replaced. */
function Setup({ t }: { t: TriggerWithSecret }) {
  const copy = (text: string) => navigator.clipboard?.writeText(text);
  const field = (label: string, value: string) => (
    <div className="setup-field">
      <span className="label">{label}</span>
      <div className="copyable">
        <code>{value}</code>
        <button type="button" className="btn sm ghost" title="Copy" onClick={() => copy(value)}>
          <Icon name="copy" />
        </button>
      </div>
    </div>
  );
  return (
    <div className="panel attn-panel">
      <h3 className="section-title">Set it up</h3>
      {t.kind === "kuma" ? (
        <>
          <p className="muted">
            In Uptime Kuma, add a Webhook notification with this Post URL, turn it on for the
            monitors Hatbot should look after, and press Test: Hatbot sends you a notification when
            it arrives. The URL holds the secret and isn't shown again.
          </p>
          {field("Post URL", `${t.url}?token=${t.secret}`)}
        </>
      ) : (
        <>
          <p className="muted">
            Use it as the secret of a Forgejo or GitHub webhook, or sign requests yourself:{" "}
            <code>
              X-Hatbot-Signature: t=&lt;unix time&gt;,v1=&lt;hex HMAC-SHA256 of "t.body"&gt;
            </code>
            . The secret isn't shown again.
          </p>
          {field("URL", t.url)}
          {field("Secret", t.secret)}
        </>
      )}
    </div>
  );
}

function TriggerEdit({ id, kind: newKind }: { id: number | null; kind: Trigger["kind"] }) {
  const stored = useStore((s) => (id === null ? undefined : s.triggers[id]));
  const [form, setForm] = useState<{
    name: string;
    kind: Trigger["kind"];
    prompt: string;
    trusted: boolean;
  } | null>(
    id === null
      ? {
          name: newKind === "kuma" ? "Uptime Kuma" : "",
          kind: newKind,
          prompt: newKind === "kuma" ? KUMA_PROMPT : "",
          trusted: false,
        }
      : null,
  );
  const [secret, setSecret] = useState<TriggerWithSecret | null>(() => {
    const t = fresh?.id === id ? fresh : null;
    fresh = null;
    return t;
  });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (id !== null && stored === undefined)
      loadSchedules().catch((err) => setError(errorText(err)));
  }, [id, stored]);
  useEffect(() => {
    if (stored && !form)
      setForm({
        name: stored.name,
        kind: stored.kind,
        prompt: stored.prompt,
        trusted: stored.trusted,
      });
  }, [stored, form]);

  if (stored === null) return <div className="empty">This trigger doesn't exist.</div>;
  if (!form) return <section className="view" />;

  const set = (patch: Partial<typeof form>) => setForm({ ...form, ...patch });
  const changed =
    !stored ||
    form.name !== stored.name ||
    form.prompt !== stored.prompt ||
    form.trusted !== stored.trusted;

  const save = async () => {
    setBusy(true);
    setError("");
    try {
      if (stored) {
        putTrigger(
          await api<Trigger>(`/triggers/${stored.id}`, {
            method: "PATCH",
            body: { name: form.name, prompt: form.prompt, trusted: form.trusted },
          }),
        );
      } else {
        const t = await api<TriggerWithSecret>("/triggers", { body: form });
        putTrigger(t);
        fresh = t;
        navigate(`/triggers/${t.id}`, true);
      }
    } catch (err) {
      setError(errorText(err));
    }
    setBusy(false);
  };
  const rotate = async () => {
    if (!stored || !confirm("Replace the secret? The old one stops working right away.")) return;
    try {
      setSecret(await api<TriggerWithSecret>(`/triggers/${stored.id}/secret`, { body: {} }));
    } catch (err) {
      setError(errorText(err));
    }
  };
  const remove = async () => {
    if (!stored || !confirm(`Delete "${stored.name}"? Its past runs stay in Tasks.`)) return;
    try {
      await api(`/triggers/${stored.id}`, { method: "DELETE" });
      navigate("/schedules");
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <section className="view">
      <div className="page narrow">
        <div className="page-head">
          <button
            type="button"
            className="btn sm ghost back"
            onClick={() => navigate("/schedules")}
          >
            <Icon name="chevron" />
            Triggers
          </button>
          <span className="spacer" />
          {stored && (
            <>
              <button type="button" className="btn sm" onClick={rotate}>
                New secret
              </button>
              <button type="button" className="btn sm danger-text" onClick={remove}>
                Delete
              </button>
            </>
          )}
        </div>

        {secret && <Setup t={secret} />}

        <div className="panel form">
          {!stored && (
            <div className="form-row">
              <span className="label">Kind</span>
              <div className="seg">
                {(["webhook", "kuma"] as const).map((k) => (
                  <button
                    type="button"
                    key={k}
                    className={form.kind === k ? "active" : ""}
                    onClick={() =>
                      set({
                        kind: k,
                        name: k === "kuma" && !form.name ? "Uptime Kuma" : form.name,
                        prompt: k === "kuma" && !form.prompt ? KUMA_PROMPT : form.prompt,
                      })
                    }
                  >
                    {KIND[k]}
                  </button>
                ))}
              </div>
            </div>
          )}
          <label>
            <span className="label">Name</span>
            <input
              className="field"
              value={form.name}
              maxLength={80}
              onChange={(e) => set({ name: e.target.value })}
            />
          </label>
          <label>
            <span className="label">
              {form.kind === "kuma"
                ? "What to do when a monitor goes down"
                : "What to do with an event"}
            </span>
            <textarea
              className="field"
              rows={5}
              maxLength={4000}
              value={form.prompt}
              onChange={(e) => set({ prompt: e.target.value })}
            />
          </label>
          {form.kind === "webhook" && (
            <div className="form-row">
              <span className="label">Trust its payloads</span>
              <Switch on={form.trusted} onChange={(trusted) => set({ trusted })} />
            </div>
          )}
          {stored && (
            <dl className="kv">
              <dt>URL</dt>
              <dd className="mono">{stored.url}</dd>
              <dt>Last event</dt>
              <dd>{stored.lastFiredAt ? stamp(stored.lastFiredAt) : "None yet"}</dd>
            </dl>
          )}
          {error && <div className="form-error">{error}</div>}
          <div className="form-actions">
            <button
              type="button"
              className="btn accent"
              disabled={busy || !changed || !form.name.trim() || !form.prompt.trim()}
              onClick={save}
            >
              {stored ? "Save" : "Create"}
            </button>
          </div>
        </div>

        {stored && <Runs filter={{ triggerId: stored.id }} />}
      </div>
    </section>
  );
}
