import type {
  ApiToken,
  AppSettings,
  CreateTokenResponse,
  Limits,
  UpdateInfo,
} from "@hatbot/shared";
import { useEffect, useRef, useState } from "react";
import { ApiError, api } from "../api";
import { Icon } from "../icons";
import { navigate } from "../router";
import { setPaused, useStore } from "../store";
import { Switch } from "../switch";
import { getTheme, setTheme, type Theme } from "../theme";
import { PluginPage, PluginsGroup } from "./Plugins";

export function Settings({
  path,
  toast,
  onSignOut,
}: {
  path: string;
  toast: (t: string) => void;
  onSignOut: () => void;
}) {
  const plugin = /^\/settings\/plugins\/([a-z0-9]+)$/.exec(path)?.[1];
  if (plugin) return <PluginPage key={plugin} id={plugin} toast={toast} />;
  return <SettingsHome toast={toast} onSignOut={onSignOut} />;
}

function SettingsHome({ toast, onSignOut }: { toast: (t: string) => void; onSignOut: () => void }) {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [newToken, setNewToken] = useState<CreateTokenResponse | null>(null);
  const [theme, setThemeState] = useState<Theme>(getTheme());
  const paused = useStore((s) => s.paused);

  useEffect(() => {
    api<AppSettings>("/settings").then(setSettings);
    api<ApiToken[]>("/tokens").then(setTokens);
  }, []);

  const update = async (patch: Partial<AppSettings>) => {
    try {
      setSettings(await api<AppSettings>("/settings", { method: "PUT", body: patch }));
      toast("Saved");
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Couldn't save");
    }
  };

  const setLimit = (key: keyof Limits, value: string) => {
    const n = Number(value);
    if (!settings || !(n > 0) || n === settings.limits[key]) return;
    void update({ limits: { ...settings.limits, [key]: n } });
  };

  const createToken = async () => {
    const name = prompt("Name for the new token, e.g. iPhone")?.trim();
    if (!name) return;
    const t = await api<CreateTokenResponse>("/tokens", { body: { name } });
    setNewToken(t);
    setTokens(await api<ApiToken[]>("/tokens"));
  };

  const revoke = async (t: ApiToken) => {
    if (!confirm(`Revoke "${t.name}"? Apps using it will be signed out.`)) return;
    await api(`/tokens/${t.id}`, { method: "DELETE" });
    setTokens(await api<ApiToken[]>("/tokens"));
  };

  const signOut = async () => {
    await api("/auth/logout", { body: {} }).catch(() => {});
    onSignOut();
  };

  if (!settings) return <section className="view" />;

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
                    onClick={() => {
                      setTheme(t);
                      setThemeState(t);
                    }}
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
              ] as const
            ).map(([key, label]) => (
              <div className="row" key={key}>
                <div className="txt">
                  <b>{label}</b>
                </div>
                $
                <input
                  type="number"
                  min="0.01"
                  step="0.01"
                  defaultValue={settings.limits[key]}
                  onBlur={(e) => setLimit(key, e.target.value)}
                />
              </div>
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
                value={settings.chatEffort}
                onChange={(e) =>
                  update({ chatEffort: e.target.value as AppSettings["chatEffort"] })
                }
              >
                <option value="low">Low</option>
                <option value="medium">Medium</option>
              </select>
            </div>
            <div className="row">
              <div className="txt">
                <b>Your name on memory edits</b>
              </div>
              <input
                type="text"
                defaultValue={settings.owner.name}
                onBlur={(e) => {
                  const name = e.target.value.trim();
                  if (name && name !== settings.owner.name)
                    void update({ owner: { ...settings.owner, name } });
                }}
              />
            </div>
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
                value={settings.desktopModel}
                onChange={(e) =>
                  update({ desktopModel: e.target.value as AppSettings["desktopModel"] })
                }
              >
                <option value="claude-opus-5-5">Opus 5.5</option>
                <option value="claude-haiku-5-5">Haiku 5.5 (cheaper, less tested)</option>
              </select>
            </div>
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
            {tokens.map((t) => (
              <div className="row" key={t.id}>
                <div className="txt">
                  <b>{t.name}</b>
                  <span>
                    API token ·{" "}
                    {t.lastUsedAt
                      ? `last used ${new Date(t.lastUsedAt).toLocaleDateString("en-GB")}`
                      : "never used"}
                  </span>
                </div>
                <button type="button" className="btn sm danger-text" onClick={() => revoke(t)}>
                  Revoke
                </button>
              </div>
            ))}
            {newToken && (
              <div className="row" style={{ display: "grid", gap: 6 }}>
                <div className="muted" style={{ fontSize: 12 }}>
                  Copy this token now. It won't be shown again.
                </div>
                <div className="token-new">{newToken.token}</div>
              </div>
            )}
            <div className="row">
              <div className="txt">
                <b>API tokens</b>
              </div>
              <button type="button" className="btn sm" onClick={createToken}>
                New token
              </button>
            </div>
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
              </div>
              <button
                type="button"
                className={`btn sm ${paused ? "" : "danger"}`}
                onClick={() =>
                  setPaused(!paused).then(() => toast(paused ? "Resumed" : "All activity paused"))
                }
              >
                {paused ? "Resume" : "Pause all"}
              </button>
            </div>
            <div className="row">
              <div className="txt">
                <b>Don't ask again for what I asked for</b>
              </div>
              <Switch
                on={settings.skipAskedApprovals}
                onChange={(on) => update({ skipAskedApprovals: on })}
              />
            </div>
            <RollbackRow toast={toast} />
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
function RollbackRow({ toast }: { toast: (t: string) => void }) {
  const [snaps, setSnaps] = useState<Snapshot[] | null>(null);
  const [error, setError] = useState("");
  const [picked, setPicked] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ configured: boolean; snapshots: Snapshot[] }>("/desktop/snapshots").then(
      (r) => {
        if (!r.configured) return;
        setSnaps(r.snapshots);
        setPicked(r.snapshots[0]?.name ?? "");
      },
      (err) => {
        setSnaps([]);
        setError(err instanceof ApiError ? err.message : "Couldn't reach Proxmox");
      },
    );
  }, []);

  if (!snaps) return null;
  const rollback = async () => {
    const snap = snaps.find((s) => s.name === picked);
    if (!snap) return;
    if (!confirm(`Roll the desktop back to ${snapLabel(snap)}? Everything since then is lost.`))
      return;
    setBusy(true);
    try {
      await api("/desktop/rollback", { body: { name: snap.name } });
      toast("Desktop rolled back");
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Couldn't roll back");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="row">
      <div className="txt">
        <b>Roll back desktop</b>
        {error && <span className="form-error">{error}</span>}
      </div>
      {snaps.length > 0 ? (
        <>
          <select value={picked} onChange={(e) => setPicked(e.target.value)} disabled={busy}>
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
function UpdateGroup({ toast }: { toast: (t: string) => void }) {
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
          else if (s.state === "current") toast("Already up to date");
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
      setError(err instanceof ApiError ? err.message : "Couldn't reach Hatbot");
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
          <span className="val version">
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
