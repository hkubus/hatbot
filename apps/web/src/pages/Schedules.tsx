// Schedules & Triggers (PLAN.md §10.3): see, pause and edit what runs on its own.
import {
  describeCron,
  HATBOT_ID,
  type Schedule,
  type Task,
  type Trigger,
  type TriggerWithSecret,
} from "@hatbot/shared";
import { type ReactNode, useEffect, useState } from "react";
import { useAction } from "../action";
import { api, errorText } from "../api";
import { BotPicker, Runs, useListed } from "../automations";
import { ask, useLeaveGuard } from "../confirm";
import { NoForm, useStoredForm } from "../form";
import { stamp } from "../format";
import { Icon } from "../icons";
import { Link } from "../link";
import { navigate } from "../router";
import { atIso, cronOk, localInput } from "../schedule-form";
import {
  loadSchedules,
  putSchedule,
  putTrigger,
  saveSchedule,
  trustSchedule,
  useStore,
} from "../store";
import { Switch } from "../switch";
import { whenText } from "../tasks";
import { BackHead, Group, SaveBar, Seg } from "../ui";
import { patchWatcher, trouble, WatcherEdit } from "./Watchers";

const KIND = { webhook: "Webhook", kuma: "Uptime Kuma" } as const;
const KUMA_PROMPT =
  "Find out why it's down. If a restart is likely to fix it, restart the service or guest once and check that it's back. Don't change configuration or delete anything. Tell me what was wrong, what you did, and whether it's working now.";
/** Failed checks before a down alert starts a task; one back up before then starts nothing. */
const CONFIRM = ["First failure", "2 failures", "3 failures"];
/** A trigger just made, so its page can show the secret after the route changes to its id. */
let fresh: TriggerWithSecret | null = null;

/** The page for /schedules, /schedules/:id, /triggers/:id, /watchers/:id, and their /new forms. */
export function SchedulesView({ path, params }: { path: string; params: URLSearchParams }) {
  const m = /^\/(schedules|triggers|watchers)\/(new|\d+)$/.exec(path);
  if (!m) return <List />;
  const id = m[2] === "new" ? null : Number(m[2]);
  if (m[1] === "watchers") return <WatcherEdit key={path} id={id} />;
  return m[1] === "schedules" ? (
    <ScheduleEdit key={path} id={id} />
  ) : (
    <TriggerEdit key={path} id={id} kind={params.get("kind") === "kuma" ? "kuma" : "webhook"} />
  );
}

function List() {
  const [ids, setIds] = useState<{
    schedules: number[];
    triggers: number[];
    watchers: number[];
  } | null>(null);
  const [error, setError] = useState("");
  const schedules = useStore((s) => s.schedules);
  const triggers = useStore((s) => s.triggers);
  const watchers = useStore((s) => s.watchers);

  useEffect(() => {
    loadSchedules().then(setIds, (err) => setError(errorText(err)));
  }, []);

  return (
    <section className="view">
      <div className="page">
        <div className="page-head">
          <span className="spacer" />
          <button type="button" className="btn" onClick={() => navigate("/schedules/new")}>
            <Icon name="plus" />
            Schedule
          </button>
          <button type="button" className="btn" onClick={() => navigate("/watchers/new")}>
            <Icon name="plus" />
            Watcher
          </button>
          <button type="button" className="btn" onClick={() => navigate("/triggers/new")}>
            <Icon name="plus" />
            Trigger
          </button>
        </div>
        {error && <div className="form-error">{error}</div>}
        {ids && (
          <>
            <RoutineGroup
              title="Schedules"
              items={schedules}
              path="/schedules"
              value={(s) => (s.enabled ? whenText(s) : "Off")}
              toggle={(s, enabled) => saveSchedule(s.id, { enabled })}
              empty="None yet. Ask Hatbot in chat, or add one here."
              onError={setError}
            />
            <RoutineGroup
              title="Watchers"
              items={watchers}
              path="/watchers"
              value={(w) =>
                w.lastError ? trouble(w)?.short : w.enabled ? (w.lastValue ?? "") : "Off"
              }
              bad={(w) => !!w.lastError && w.errors > 0}
              toggle={(w, enabled) => patchWatcher(w.id, { enabled })}
              empty="None yet. Ask Hatbot to tell you when something changes."
              onError={setError}
            />
            <RoutineGroup
              title="Triggers"
              items={triggers}
              path="/triggers"
              value={(t) => (t.enabled ? KIND[t.kind] : "Off")}
              toggle={(t, enabled) =>
                api<Trigger>(`/triggers/${t.id}`, { method: "PATCH", body: { enabled } }).then(
                  putTrigger,
                )
              }
              empty="None yet."
              onError={setError}
            />
          </>
        )}
      </div>
    </section>
  );
}

/** One kind on the list, by name, each with its switch. */
function RoutineGroup<T extends { id: number; name: string; enabled: boolean }>({
  title,
  items,
  path,
  value,
  bad,
  toggle,
  empty,
  onError,
}: {
  title: string;
  /** As in the store, where a deleted one is null. */
  items: Record<number, T | null>;
  path: string;
  /** What it's doing, beside its name. */
  value: (item: T) => ReactNode;
  bad?: (item: T) => boolean;
  toggle: (item: T, enabled: boolean) => Promise<unknown>;
  empty: string;
  onError: (error: string) => void;
}) {
  const shown = Object.values(items)
    .filter((x): x is T => Boolean(x))
    .sort((a, b) => a.name.localeCompare(b.name));
  return (
    <Group title={title}>
      {shown.map((x) => (
        <div className="row" key={x.id}>
          <Link className="row-main" to={`${path}/${x.id}`}>
            <div className="txt">
              <b>{x.name}</b>
            </div>
            <span className={bad?.(x) ? "val bad" : "val"}>{value(x)}</span>
            <Icon name="chevron" className="chev" />
          </Link>
          <Switch
            on={x.enabled}
            onChange={(enabled) => toggle(x, enabled).catch((err) => onError(errorText(err)))}
          />
        </div>
      ))}
      {!shown.length && (
        <div className="row">
          <span className="muted">{empty}</span>
        </div>
      )}
    </Group>
  );
}

const NEW_SCHEDULE = {
  name: "",
  repeat: true,
  cron: "0 8 * * *",
  at: "",
  prompt: "",
  botId: HATBOT_ID,
};

const scheduleForm = (s: Schedule): typeof NEW_SCHEDULE => ({
  name: s.name,
  repeat: Boolean(s.cron),
  cron: s.cron ?? "0 8 * * *",
  at: s.runAt ? localInput(s.runAt) : "",
  prompt: s.prompt,
  botId: s.botId,
});

function ScheduleEdit({ id }: { id: number | null }) {
  const stored = useStore((s) => (id === null ? undefined : s.schedules[id]));
  // A run of it that hasn't ended: Run now waits for it.
  const running = useStore(
    (s) => id !== null && Object.values(s.tasks).some((t) => t.scheduleId === id && !t.finishedAt),
  );
  // A change made elsewhere comes in while you haven't edited it.
  const { form, dirty, set, saved } = useStoredForm(
    id === null ? NEW_SCHEDULE : stored ? scheduleForm(stored) : undefined,
  );
  const { busy, error, setError, run } = useAction();
  const listed = useListed("schedules", id, stored);
  // Deleted elsewhere: there's nothing left to save.
  const edited = dirty && stored !== null;
  const release = useLeaveGuard(edited);

  if (listed.missing || !form)
    return (
      <NoForm
        error={listed.error}
        missing={listed.missing ? "This schedule doesn't exist." : ""}
        retry={listed.load}
        back={{ label: "Schedules", to: "/schedules" }}
      />
    );

  // The time you see, as a moment: the brain would read it in its own time zone.
  const when = form.repeat ? { cron: form.cron.trim() } : { at: atIso(form.at) };
  const changed = !stored || stored.tainted || edited;
  const cron = form.cron.trim();
  const described = form.repeat ? describeCron(cron) : "";

  const save = () =>
    run(async () => {
      if (stored) {
        const s = await saveSchedule(stored.id, {
          name: form.name,
          prompt: form.prompt,
          botId: form.botId,
          ...when,
          ...(!stored.enabled && !stored.cron ? { enabled: true } : {}),
        });
        saved(form, scheduleForm(s));
      } else {
        const s = await api<Schedule>("/schedules", {
          body: { name: form.name, prompt: form.prompt, botId: form.botId, ...when },
        });
        putSchedule(s);
        release();
        navigate(`/schedules/${s.id}`, true);
      }
    });
  const remove = async () => {
    if (
      !stored ||
      !(await ask({ text: `Delete "${stored.name}"? Its past runs stay in Tasks.`, ok: "Delete" }))
    )
      return;
    await run(async () => {
      await api(`/schedules/${stored.id}`, { method: "DELETE" });
      release();
      navigate("/schedules");
    });
  };
  // Runs what's saved: off while you have unsaved changes, and while a run is going.
  const runNow = () =>
    run(async () => {
      if (!stored) return;
      const task = await api<Task>(`/schedules/${stored.id}/run`, { body: {} });
      navigate(`/tasks/${task.id}`);
    });

  return (
    <section className="view">
      <div className="page narrow">
        <BackHead to="/schedules" label="Schedules">
          {stored && (
            <>
              <button
                type="button"
                className="btn sm"
                disabled={edited || running || busy}
                title={edited ? "Save your changes first" : running ? "It's running" : undefined}
                onClick={runNow}
              >
                <Icon name="play" />
                Run now
              </button>
              <button type="button" className="btn sm danger-text" onClick={remove}>
                Delete
              </button>
            </>
          )}
        </BackHead>

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
            <Seg
              value={form.repeat}
              options={[
                [true, "Repeats"],
                [false, "Once"],
              ]}
              onChange={(repeat) => set({ repeat })}
            />
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
              {cron && !cronOk(cron) ? (
                <span className="form-error hint">Not a valid cron</span>
              ) : (
                <span className="muted hint">
                  {cron && described !== cron ? described : "minute hour day month weekday"}
                </span>
              )}
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
          <BotPicker value={form.botId} onChange={(botId) => set({ botId })} />
          {stored?.tainted && (
            <div className="hint">
              Hatbot wrote this after reading untrusted content
              {stored.taintedBy ? ` (${stored.taintedBy})` : ""}, so its runs ask before changing
              anything. Check what it does, then trust it.{" "}
              <button
                type="button"
                className="btn sm"
                onClick={() =>
                  void trustSchedule(stored.id).catch((err) => setError(errorText(err)))
                }
              >
                Trust
              </button>
            </div>
          )}
          {stored && (
            <dl className="kv">
              <dt>Next run</dt>
              <dd>{stored.enabled && stored.nextRunAt ? stamp(stored.nextRunAt) : "Off"}</dd>
            </dl>
          )}
          <SaveBar
            error={error}
            disabled={busy || !changed || !form.name.trim() || !form.prompt.trim()}
            onSave={save}
            label={stored ? "Save" : "Create"}
          />
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

const triggerForm = (t: Trigger) => ({
  name: t.name,
  kind: t.kind,
  prompt: t.prompt,
  trusted: t.trusted,
  confirmChecks: t.confirmChecks,
  botId: t.botId,
});

function TriggerEdit({ id, kind: newKind }: { id: number | null; kind: Trigger["kind"] }) {
  const stored = useStore((s) => (id === null ? undefined : s.triggers[id]));
  const [start] = useState(() => ({
    name: newKind === "kuma" ? "Uptime Kuma" : "",
    kind: newKind,
    prompt: newKind === "kuma" ? KUMA_PROMPT : "",
    trusted: false,
    confirmChecks: 0,
    botId: HATBOT_ID,
  }));
  // A change made elsewhere comes in while you haven't edited it.
  const { form, dirty, set, saved } = useStoredForm(
    id === null ? start : stored ? triggerForm(stored) : undefined,
  );
  const [secret, setSecret] = useState<TriggerWithSecret | null>(() => {
    const t = fresh?.id === id ? fresh : null;
    fresh = null;
    return t;
  });
  const { busy, error, run } = useAction();
  const listed = useListed("triggers", id, stored);
  // Deleted elsewhere: there's nothing left to save.
  const edited = dirty && stored !== null;
  const release = useLeaveGuard(edited);

  if (listed.missing || !form)
    return (
      <NoForm
        error={listed.error}
        missing={listed.missing ? "This trigger doesn't exist." : ""}
        retry={listed.load}
        back={{ label: "Triggers", to: "/schedules" }}
      />
    );

  const changed = !stored || edited;

  const save = () =>
    run(async () => {
      if (stored) {
        const t = await api<Trigger>(`/triggers/${stored.id}`, {
          method: "PATCH",
          body: {
            name: form.name,
            prompt: form.prompt,
            trusted: form.trusted,
            confirmChecks: form.confirmChecks,
            botId: form.botId,
          },
        });
        putTrigger(t);
        saved(form, triggerForm(t));
      } else {
        const t = await api<TriggerWithSecret>("/triggers", { body: form });
        putTrigger(t);
        fresh = t;
        release();
        navigate(`/triggers/${t.id}`, true);
      }
    });
  const rotate = async () => {
    if (
      !stored ||
      !(await ask({
        text: "Replace the secret? The old one stops working right away.",
        ok: "Replace",
      }))
    )
      return;
    await run(async () =>
      setSecret(await api<TriggerWithSecret>(`/triggers/${stored.id}/secret`, { body: {} })),
    );
  };
  const remove = async () => {
    if (
      !stored ||
      !(await ask({ text: `Delete "${stored.name}"? Its past runs stay in Tasks.`, ok: "Delete" }))
    )
      return;
    await run(async () => {
      await api(`/triggers/${stored.id}`, { method: "DELETE" });
      release();
      navigate("/schedules");
    });
  };

  return (
    <section className="view">
      <div className="page narrow">
        <BackHead to="/schedules" label="Triggers">
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
        </BackHead>

        {secret && <Setup t={secret} />}

        <div className="panel form">
          {!stored && (
            <div className="form-row">
              <span className="label">Kind</span>
              <Seg
                value={form.kind}
                options={(["webhook", "kuma"] as const).map((k) => [k, KIND[k]] as const)}
                onChange={(k) =>
                  set({
                    kind: k,
                    name: k === "kuma" && !form.name ? "Uptime Kuma" : form.name,
                    prompt: k === "kuma" && !form.prompt ? KUMA_PROMPT : form.prompt,
                  })
                }
              />
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
          <BotPicker value={form.botId} onChange={(botId) => set({ botId })} />
          {form.kind === "kuma" && (
            <div className="form-row">
              <span className="label">Start a task after</span>
              <Seg
                value={form.confirmChecks}
                options={CONFIRM.map((label, n) => [n, label] as const)}
                onChange={(confirmChecks) => set({ confirmChecks })}
              />
            </div>
          )}
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
          <SaveBar
            error={error}
            disabled={busy || !changed || !form.name.trim() || !form.prompt.trim()}
            onSave={save}
            label={stored ? "Save" : "Create"}
          />
        </div>

        {stored && <Runs filter={{ triggerId: stored.id }} />}
      </div>
    </section>
  );
}
