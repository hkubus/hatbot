import {
  type ApiToken,
  type AppSettings,
  type CreateTokenResponse,
  describeEvery,
  type Limits,
  type UpdateInfo,
} from "@hatbot/shared";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useAction } from "../action";
import { api, errorText } from "../api";
import { ask, askText } from "../confirm";
import { clearDrafts } from "../drafts";
import { Icon } from "../icons";
import { LoadError, loadErrorText } from "../load";
import { navigate } from "../router";
import { parseLimit, parseName, SavedRow } from "../saved-row";
import { setPaused, useStore } from "../store";
import { Switch } from "../switch";
import { setTheme, useTheme } from "../theme";
import type { Toast } from "../toast";
import { PluginPage, PluginsGroup } from "./Plugins";

const Account = lazy(() => import("./Account").then((m) => ({ default: m.Account })));
const Checks = lazy(() => import("./Checks").then((m) => ({ default: m.Checks })));
const HeartbeatPage = lazy(() => import("./Heartbeat").then((m) => ({ default: m.HeartbeatPage })));

const HOURS = Array.from({ length: 24 }, (_, h) => h);
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * A change to the settings. The brain merges limits into the saved ones, so only the one edited is
 * sent, and two quick edits don't undo each other.
 */
type Patch = Partial<Omit<AppSettings, "limits">> & { limits?: Partial<Limits> };

export function Settings({
  path,
  toast,
  onSignOut,
}: {
  path: string;
  toast: Toast;
  onSignOut: () => void;
}) {
  const plugin = /^\/settings\/plugins\/([a-z0-9]+)$/.exec(path)?.[1];
  const page = plugin ? (
    <PluginPage key={plugin} id={plugin} toast={toast} />
  ) : path === "/settings/account" ? (
    <Account toast={toast} />
  ) : path === "/settings/checks" ? (
    <Checks />
  ) : path === "/settings/heartbeat" ? (
    <HeartbeatPage toast={toast} />
  ) : null;
  if (page) return <Suspense fallback={<section className="view" />}>{page}</Suspense>;
  return <SettingsHome toast={toast} onSignOut={onSignOut} />;
}

function SettingsHome({ toast, onSignOut }: { toast: Toast; onSignOut: () => void }) {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [newToken, setNewToken] = useState<CreateTokenResponse | null>(null);
  const theme = useTheme();
  const paused = useStore((s) => s.paused);
  const [loadError, setLoadError] = useState("");
  // Saved elsewhere (the app, another tab): shown here too.
  const settingsVersion = useStore((s) => s.settingsVersion);
  useEffect(() => {
    if (settingsVersion) api<AppSettings>("/settings").then(setSettings, () => {});
  }, [settingsVersion]);

  const load = useCallback(() => {
    setLoadError("");
    Promise.all([api<AppSettings>("/settings"), api<ApiToken[]>("/tokens")]).then(
      ([s, t]) => {
        setSettings(s);
        setTokens(t);
      },
      (err) => setLoadError(loadErrorText(err)),
    );
  }, []);
  useEffect(load, [load]);

  /** Rejects with the brain's message, for a field to show beside itself. */
  const put = async (patch: Patch) => {
    setSettings(await api<AppSettings>("/settings", { method: "PUT", body: patch }));
    toast("Saved");
  };
  const update = (patch: Partial<AppSettings>) =>
    put(patch).catch((err) => toast(errorText(err, "Couldn't save"), "error"));

  const tokenEdit = useAction();
  const pausing = useAction();
  const createToken = async () => {
    const name = await askText({
      text: "Name for the new token",
      placeholder: "iPhone",
      ok: "Create",
    });
    if (!name) return;
    await tokenEdit.run(async () => {
      setNewToken(await api<CreateTokenResponse>("/tokens", { body: { name } }));
      setTokens(await api<ApiToken[]>("/tokens"));
    });
  };

  const revoke = async (t: ApiToken) => {
    if (
      !(await ask({ text: `Revoke "${t.name}"? Apps using it will be signed out.`, ok: "Revoke" }))
    )
      return;
    await tokenEdit.run(async () => {
      await api(`/tokens/${t.id}`, { method: "DELETE" });
      setTokens(await api<ApiToken[]>("/tokens"));
    });
  };

  const pause = () =>
    pausing.run(async () => {
      await setPaused(!paused);
      toast(paused ? "Resumed" : "All activity paused");
    });

  const signOut = async () => {
    await api("/auth/logout", { body: {} }).catch(() => {});
    clearDrafts();
    onSignOut();
  };

  if (!settings)
    return (
      <section className="view">
        {loadError && (
          <div className="page">
            <LoadError error={loadError} retry={load} />
          </div>
        )}
      </section>
    );

  return (
    <section className="view">
      <div className="page">
        <section className="group">
          <h2>Appearance</h2>
          <div className="group-box">
            <div className="row">
              <div className="txt">
                <b>Theme</b>
              </div>
              <div className="seg">
                {(["system", "light", "dark"] as const).map((t) => (
                  <button
                    type="button"
                    key={t}
                    className={theme === t ? "active" : ""}
                    aria-pressed={theme === t}
                    onClick={() => setTheme(t)}
                  >
                    {t[0]?.toUpperCase() + t.slice(1)}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </section>

        <section className="group show-phone">
          <div className="group-box">
            <button type="button" className="row link" onClick={() => navigate("/schedules")}>
              <div className="txt">
                <b>Schedules & Triggers</b>
              </div>
              <Icon name="chevron" className="chev" />
            </button>
            <button type="button" className="row link" onClick={() => navigate("/spend")}>
              <div className="txt">
                <b>Spend</b>
              </div>
              <Icon name="chevron" className="chev" />
            </button>
          </div>
        </section>

        <section className="group">
          <h2>Spending limits</h2>
          <div className="group-box">
            {(
              [
                ["dailyUsd", "Per day"],
                ["monthlyUsd", "Per month"],
                ["taskUsd", "Per task"],
                ["researchUsd", "Per research task"],
                ["alertReserveUsd", "Kept for alerts"],
              ] as const
            ).map(([key, label]) => (
              <SavedRow
                key={key}
                label={label}
                saved={settings.limits[key]}
                // Nothing kept for alerts is allowed; a limit of nothing isn't.
                parse={(text) => parseLimit(text, key === "alertReserveUsd")}
                save={(n) => put({ limits: { [key]: n } })}
                prefix="$"
                input={{
                  type: "number",
                  inputMode: "decimal",
                  min: key === "alertReserveUsd" ? "0" : "0.01",
                  step: "0.01",
                }}
              />
            ))}
          </div>
        </section>

        <section className="group">
          <h2>Chat</h2>
          <div className="group-box">
            <div className="row">
              <div className="txt">
                <b>Model</b>
              </div>
              <select
                aria-label="Chat model"
                value={settings.chatModel}
                onChange={(e) => update({ chatModel: e.target.value as AppSettings["chatModel"] })}
              >
                <option value="claude-haiku-5-5">Haiku 5.5, asks Opus for hard parts</option>
                <option value="claude-opus-5-5">Opus 5.5</option>
              </select>
            </div>
            <div className="row">
              <div className="txt">
                <b>Effort</b>
              </div>
              <select
                aria-label="Chat effort"
                value={settings.chatEffort}
                onChange={(e) =>
                  update({ chatEffort: e.target.value as AppSettings["chatEffort"] })
                }
              >
                <option value="low">Low</option>
                <option value="medium">Medium</option>
              </select>
            </div>
            <SavedRow
              label="Your name on memory edits"
              saved={settings.owner.name}
              parse={parseName}
              save={(name) => put({ owner: { ...settings.owner, name } })}
              input={{ type: "text" }}
            />
          </div>
        </section>

        <section className="group">
          <h2>Tasks</h2>
          <div className="group-box">
            <div className="row">
              <div className="txt">
                <b>Model for background tasks</b>
              </div>
              <select
                aria-label="Model for background tasks"
                value={settings.taskModel}
                onChange={(e) => update({ taskModel: e.target.value as AppSettings["taskModel"] })}
              >
                <option value="claude-haiku-5-5">Haiku 5.5</option>
                <option value="claude-opus-5-5">Opus 5.5</option>
              </select>
            </div>
          </div>
        </section>

        <section className="group">
          <h2>Looking after things</h2>
          <div className="group-box">
            <button
              type="button"
              className="row link"
              onClick={() => navigate("/settings/heartbeat")}
            >
              <div className="txt">
                <b>Heartbeat</b>
              </div>
              <span className="val">
                {settings.heartbeat.enabled
                  ? describeEvery(settings.heartbeat.everyMinutes)
                  : "Off"}
              </span>
              <Icon name="chevron" className="chev" />
            </button>
            <div className="row">
              <div className="txt">
                <b>Propose a memory tidy-up weekly</b>
              </div>
              <Switch on={settings.memoryTidy} onChange={(memoryTidy) => update({ memoryTidy })} />
            </div>
            <div className="row">
              <div className="txt">
                <b>Weekly report</b>
              </div>
              <Switch
                on={settings.weeklyReport.enabled}
                onChange={(enabled) =>
                  update({ weeklyReport: { ...settings.weeklyReport, enabled } })
                }
              />
            </div>
            {settings.weeklyReport.enabled && (
              <div className="row">
                <div className="txt">
                  <b>Sent on</b>
                </div>
                <select
                  aria-label="Sent on"
                  value={settings.weeklyReport.weekday}
                  onChange={(e) =>
                    update({
                      weeklyReport: { ...settings.weeklyReport, weekday: Number(e.target.value) },
                    })
                  }
                >
                  {WEEKDAYS.map((d, i) => (
                    <option key={d} value={i}>
                      {d}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="Sent at"
                  value={settings.weeklyReport.hour}
                  onChange={(e) =>
                    update({
                      weeklyReport: { ...settings.weeklyReport, hour: Number(e.target.value) },
                    })
                  }
                >
                  {HOURS.map((h) => (
                    <option key={h} value={h}>
                      {String(h).padStart(2, "0")}:00
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="btn sm"
                  onClick={() =>
                    api("/report/send", { body: {} }).then(
                      () => toast("Sent to Hatbot's chat"),
                      () => toast("Couldn't send", "error"),
                    )
                  }
                >
                  Send now
                </button>
              </div>
            )}
          </div>
        </section>

        <section className="group">
          <h2>Desktop</h2>
          <div className="group-box">
            <div className="row">
              <div className="txt">
                <b>Model for desktop tasks</b>
              </div>
              <select
                aria-label="Model for desktop tasks"
                value={settings.desktopModel}
                onChange={(e) =>
                  update({ desktopModel: e.target.value as AppSettings["desktopModel"] })
                }
              >
                <option value="claude-haiku-5-5">Haiku 5.5</option>
                <option value="claude-opus-5-5">Opus 5.5</option>
              </select>
            </div>
            {settings.desktopModel === "claude-haiku-5-5" && (
              <div className="row">
                <div className="txt">
                  <b>Try again on Opus when Haiku fails</b>
                </div>
                <Switch
                  on={settings.desktopEscalate}
                  onChange={(desktopEscalate) => update({ desktopEscalate })}
                />
              </div>
            )}
          </div>
        </section>

        <section className="group">
          <h2>Notifications</h2>
          <div className="group-box">
            <div className="row">
              <div className="txt">
                <b>Tapping one opens</b>
              </div>
              <select
                aria-label="Tapping one opens"
                value={settings.notificationsOpen}
                onChange={(e) =>
                  update({
                    notificationsOpen: e.target.value as AppSettings["notificationsOpen"],
                  })
                }
              >
                <option value="web">The web app</option>
                <option value="app">The iOS app</option>
              </select>
            </div>
          </div>
        </section>

        <section className="group">
          <h2>Account</h2>
          <div className="group-box">
            <button
              type="button"
              className="row link"
              onClick={() => navigate("/settings/account")}
            >
              <div className="txt">
                <b>Password and sign-ins</b>
              </div>
              <Icon name="chevron" className="chev" />
            </button>
            <div className="row">
              <div className="txt">
                <b>API tokens</b>
                {tokenEdit.error && <span className="form-error">{tokenEdit.error}</span>}
              </div>
              <button type="button" className="btn sm" onClick={createToken}>
                New token
              </button>
            </div>
            {newToken && (
              <div className="row" style={{ display: "grid", gap: 6 }}>
                <div className="muted" style={{ fontSize: 12 }}>
                  Copy this token now. It won't be shown again.
                </div>
                <div className="token-new">{newToken.token}</div>
              </div>
            )}
            {tokens.map((t) => (
              <div className="row" key={t.id}>
                <div className="txt">
                  <b>{t.name}</b>
                </div>
                <span className="val">
                  {t.lastUsedAt
                    ? `Used ${new Date(t.lastUsedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}`
                    : "Never used"}
                </span>
                <button type="button" className="btn sm danger-text" onClick={() => revoke(t)}>
                  Revoke
                </button>
              </div>
            ))}
            <div className="row">
              <div className="txt">
                <b>Sign out</b>
              </div>
              <button type="button" className="btn sm" onClick={signOut}>
                Sign out
              </button>
            </div>
          </div>
        </section>

        <PluginsGroup />

        <section className="group">
          <h2>Safety</h2>
          <div className="group-box">
            <div className="row">
              <div className="txt">
                <b>Pause all activity</b>
                {pausing.error && <span className="form-error">{pausing.error}</span>}
              </div>
              <button type="button" className={`btn sm ${paused ? "" : "danger"}`} onClick={pause}>
                {paused ? "Resume" : "Pause all"}
              </button>
            </div>
            <div className="row">
              <div className="txt">
                <b>Let Haiku allow safe changes</b>
              </div>
              <Switch
                on={settings.reviewChanges}
                onChange={(on) => update({ reviewChanges: on })}
              />
            </div>
            <RollbackRow toast={toast} />
          </div>
        </section>

        <section className="group">
          <div className="group-box">
            <button type="button" className="row link" onClick={() => navigate("/settings/checks")}>
              <div className="txt">
                <b>Check everything</b>
              </div>
              <Icon name="chevron" className="chev" />
            </button>
          </div>
        </section>

        <UpdateGroup toast={toast} />
      </div>
    </section>
  );
}

type Snapshot = { name: string; description: string; createdAt: string | null };

const snapLabel = (s: Snapshot) =>
  s.createdAt
    ? new Date(s.createdAt).toLocaleString("en-GB", {
        weekday: "short",
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      })
    : s.name;

/** Rolls the desktop back to a nightly snapshot through the Proxmox API (PLAN.md §8). */
function RollbackRow({ toast }: { toast: Toast }) {
  const [snaps, setSnaps] = useState<Snapshot[] | null>(null);
  const [error, setError] = useState("");
  const [picked, setPicked] = useState("");
  const { busy, run } = useAction();

  useEffect(() => {
    api<{ configured: boolean; snapshots: Snapshot[] }>("/desktop/snapshots").then(
      (r) => {
        if (!r.configured) return;
        setSnaps(r.snapshots);
        setPicked(r.snapshots[0]?.name ?? "");
      },
      (err) => {
        setSnaps([]);
        setError(errorText(err, "Couldn't reach Proxmox"));
      },
    );
  }, []);

  if (!snaps) return null;
  const rollback = async () => {
    const snap = snaps.find((s) => s.name === picked);
    if (!snap) return;
    if (
      !(await ask({
        text: `Roll the desktop back to ${snapLabel(snap)}? Everything since then is lost.`,
        ok: "Roll back",
      }))
    )
      return;
    await run(
      async () => {
        await api("/desktop/rollback", { body: { name: snap.name } });
        toast("Desktop rolled back");
      },
      (err) => toast(errorText(err, "Couldn't roll back"), "error"),
    );
  };

  return (
    <div className="row">
      <div className="txt">
        <b>Roll back desktop</b>
        {error && <span className="form-error">{error}</span>}
      </div>
      {snaps.length > 0 ? (
        <>
          <select
            aria-label="Snapshot"
            value={picked}
            onChange={(e) => setPicked(e.target.value)}
            disabled={busy}
          >
            {snaps.map((s) => (
              <option key={s.name} value={s.name}>
                {snapLabel(s)}
              </option>
            ))}
          </select>
          <button type="button" className="btn sm danger-text" disabled={busy} onClick={rollback}>
            {busy ? "Rolling back…" : "Roll back"}
          </button>
        </>
      ) : (
        !error && <span className="val">No snapshots yet</span>
      )}
    </div>
  );
}

const short = (sha?: string) => sha?.slice(0, 7) ?? "";

/** Pulls from git and redeploys the desktop and the brain (infra/hatbot-update.sh). */
function UpdateGroup({ toast }: { toast: Toast }) {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [error, setError] = useState("");
  // The update being watched: the status that was there before it started.
  const watching = useRef<{ before?: string; sha?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const pollSoon = useRef<() => void>(() => {});

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const schedule = (ms: number) => {
      clearTimeout(timer);
      if (!stopped) timer = setTimeout(poll, ms);
    };
    pollSoon.current = () => schedule(1000);
    const poll = async () => {
      try {
        const next = await api<UpdateInfo>("/update");
        if (stopped) return;
        setInfo(next);
        const w = watching.current;
        const s = next.status;
        const running = next.requested || s?.state === "running";
        if (!w && running) {
          watching.current = { before: undefined, sha: next.current?.sha };
          setBusy(true);
        } else if (w && !running && s && s.startedAt !== w.before) {
          watching.current = null;
          setBusy(false);
          if (s.state === "failed") setError(s.error ?? "The update failed.");
          else if (s.state === "current") toast("Already up to date", "info");
          else if (next.current?.sha !== w.sha) {
            // The brain restarted on new code; load the new web app too.
            toast(`Updated to ${short(next.current?.sha)}`);
            setTimeout(() => location.reload(), 1200);
          }
        }
      } catch {
        // The brain restarts at the end of an update; keep asking.
      }
      schedule(watching.current ? 2000 : 30_000);
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [toast]);

  if (!info) return null;
  const update = async () => {
    setError("");
    watching.current = { before: info.status?.startedAt, sha: info.current?.sha };
    setBusy(true);
    try {
      setInfo(await api<UpdateInfo>("/update", { body: {} }));
      pollSoon.current();
    } catch (err) {
      watching.current = null;
      setBusy(false);
      setError(errorText(err, "Couldn't reach Hatbot"));
    }
  };
  const step = info.status?.state === "running" ? info.status.step : "Starting";
  const notes = !busy && info.status?.state === "done" ? info.status.notes : [];

  return (
    <section className="group">
      <h2>Updates</h2>
      <div className="group-box">
        <div className="row">
          <div className="txt">
            <b>Version</b>
          </div>
          <span className="val">
            {info.current?.sha
              ? `${short(info.current.sha)}${info.current.subject ? ` ${info.current.subject}` : ""}`
              : "Unknown"}
          </span>
        </div>
        <div className="row">
          <div className="txt">
            <b>Update from git</b>
            {error && <span className="form-error">{error}</span>}
            {notes.map((n) => (
              <span key={n}>{n}</span>
            ))}
          </div>
          {info.source ? (
            <button type="button" className="btn sm" disabled={busy} onClick={update}>
              {busy ? `${step}…` : "Update"}
            </button>
          ) : (
            <span className="val">Not set up</span>
          )}
        </div>
      </div>
    </section>
  );
}
