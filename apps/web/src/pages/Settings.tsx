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
import { day, stamp } from "../format";
import { LoadError } from "../load";
import { parseLimit, parseName, SavedRow } from "../saved-row";
import { setPaused, useStore } from "../store";
import { Switch } from "../switch";
import { setTheme, useTheme } from "../theme";
import type { Toast } from "../toast";
import { CHAT_MODELS, EFFORTS, Group, LinkRow, MODELS, Row, Seg, Select } from "../ui";
import { PluginPage, PluginsGroup } from "./Plugins";

const Account = lazy(() => import("./Account").then((m) => ({ default: m.Account })));
const Checks = lazy(() => import("./Checks").then((m) => ({ default: m.Checks })));
const Connections = lazy(() => import("./Connections").then((m) => ({ default: m.Connections })));
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
  ) : path === "/settings/connections" ? (
    <Connections toast={toast} />
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
      (err) => setLoadError(errorText(err)),
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
        <Group title="Appearance">
          <Row label="Theme">
            <Seg
              value={theme}
              options={[
                ["system", "System"],
                ["light", "Light"],
                ["dark", "Dark"],
              ]}
              onChange={setTheme}
            />
          </Row>
        </Group>

        <Group className="show-phone">
          <LinkRow to="/todo" label="To-do" />
          <LinkRow to="/boxes" label="Boxes" />
          <LinkRow to="/schedules" label="Schedules & Triggers" />
          <LinkRow to="/spend" label="Spend" />
        </Group>

        <Group title="Spending limits">
          {(
            [
              ["dailyUsd", "Per day"],
              ["monthlyUsd", "Per month"],
              ["taskUsd", "Per task"],
              ["researchUsd", "Per research task"],
              ["alertReserveUsd", "Kept for alerts"],
              ["boxesUsd", "Boxes per day"],
            ] as const
          ).map(([key, label]) => (
            <SavedRow
              key={key}
              label={label}
              saved={settings.limits[key]}
              // Nothing kept for alerts is allowed, and boxes asking nothing; a limit of nothing isn't.
              parse={(text) => parseLimit(text, key === "alertReserveUsd" || key === "boxesUsd")}
              save={(n) => put({ limits: { [key]: n } })}
              prefix="$"
              input={{
                type: "number",
                inputMode: "decimal",
                min: key === "alertReserveUsd" || key === "boxesUsd" ? "0" : "0.01",
                step: "0.01",
              }}
            />
          ))}
        </Group>

        <Group title="Chat">
          <Row label="Model">
            <Select
              label="Chat model"
              value={settings.chatModel}
              options={CHAT_MODELS}
              onChange={(chatModel) => update({ chatModel })}
            />
          </Row>
          <Row label="Effort">
            <Select
              label="Chat effort"
              value={settings.chatEffort}
              options={EFFORTS}
              onChange={(chatEffort) => update({ chatEffort })}
            />
          </Row>
          <SavedRow
            label="Your name on memory edits"
            saved={settings.owner.name}
            parse={parseName}
            save={(name) => put({ owner: { ...settings.owner, name } })}
            input={{ type: "text" }}
          />
        </Group>

        <Group title="Tasks">
          <Row label="Model for background tasks">
            <Select
              label="Model for background tasks"
              value={settings.taskModel}
              options={MODELS}
              onChange={(taskModel) => update({ taskModel })}
            />
          </Row>
        </Group>

        <Group title="Looking after things">
          <LinkRow to="/settings/heartbeat" label="Heartbeat">
            <span className="val">
              {settings.heartbeat.enabled ? describeEvery(settings.heartbeat.everyMinutes) : "Off"}
            </span>
          </LinkRow>
          <Row label="Propose a memory tidy-up weekly">
            <Switch on={settings.memoryTidy} onChange={(memoryTidy) => update({ memoryTidy })} />
          </Row>
          <Row label="Weekly report">
            <Switch
              on={settings.weeklyReport.enabled}
              onChange={(enabled) =>
                update({ weeklyReport: { ...settings.weeklyReport, enabled } })
              }
            />
          </Row>
          {settings.weeklyReport.enabled && (
            <Row label="Sent on">
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
            </Row>
          )}
          <Row label="To-do reminder each morning at">
            <select
              aria-label="To-do reminder each morning at"
              value={settings.todoHour}
              onChange={(e) => update({ todoHour: Number(e.target.value) })}
            >
              {HOURS.map((h) => (
                <option key={h} value={h}>
                  {String(h).padStart(2, "0")}:00
                </option>
              ))}
            </select>
          </Row>
        </Group>

        <Group title="Desktop">
          <Row label="Model for desktop tasks">
            <Select
              label="Model for desktop tasks"
              value={settings.desktopModel}
              options={MODELS}
              onChange={(desktopModel) => update({ desktopModel })}
            />
          </Row>
          {settings.desktopModel === "claude-haiku-5-5" && (
            <Row label="Try again on Opus when Haiku fails">
              <Switch
                on={settings.desktopEscalate}
                onChange={(desktopEscalate) => update({ desktopEscalate })}
              />
            </Row>
          )}
        </Group>

        <Group title="Connections">
          <LinkRow to="/settings/connections" label="Anthropic API key and ntfy server" />
        </Group>

        <Group title="Notifications">
          <Row label="Tapping one opens">
            <Select
              label="Tapping one opens"
              value={settings.notificationsOpen}
              options={[
                ["web", "The web app"],
                ["app", "The iOS app"],
              ]}
              onChange={(notificationsOpen) => update({ notificationsOpen })}
            />
          </Row>
        </Group>

        <Group title="Account">
          <LinkRow to="/settings/account" label="Password and sign-ins" />
          <Row
            label="API tokens"
            sub={tokenEdit.error && <span className="form-error">{tokenEdit.error}</span>}
          >
            <button type="button" className="btn sm" onClick={createToken}>
              New token
            </button>
          </Row>
          {newToken && (
            <div className="row" style={{ display: "grid", gap: 6 }}>
              <div className="muted" style={{ fontSize: 12 }}>
                Copy this token now. It won't be shown again.
              </div>
              <div className="token-new">{newToken.token}</div>
            </div>
          )}
          {tokens.map((t) => (
            <Row key={t.id} label={t.name}>
              <span className="val">
                {t.lastUsedAt ? `Used ${day(t.lastUsedAt)}` : "Never used"}
              </span>
              <button type="button" className="btn sm danger-text" onClick={() => revoke(t)}>
                Revoke
              </button>
            </Row>
          ))}
          <Row label="Sign out">
            <button type="button" className="btn sm" onClick={signOut}>
              Sign out
            </button>
          </Row>
        </Group>

        <PluginsGroup />

        <Group title="Safety">
          <Row
            label="Pause all activity"
            sub={pausing.error && <span className="form-error">{pausing.error}</span>}
          >
            <button type="button" className={`btn sm ${paused ? "" : "danger"}`} onClick={pause}>
              {paused ? "Resume" : "Pause all"}
            </button>
          </Row>
          <Row label="Let Haiku and Opus allow safe changes">
            <Switch on={settings.reviewChanges} onChange={(on) => update({ reviewChanges: on })} />
          </Row>
          <RollbackRow toast={toast} />
        </Group>

        <Group>
          <LinkRow to="/settings/checks" label="Check everything" />
        </Group>

        <UpdateGroup toast={toast} />
      </div>
    </section>
  );
}

type Snapshot = { name: string; description: string; createdAt: string | null };

const snapLabel = (s: Snapshot) => (s.createdAt ? stamp(s.createdAt) : s.name);

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
        setError(errorText(err, "Couldn't reach Proxmox."));
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
    <Row label="Roll back desktop" sub={error && <span className="form-error">{error}</span>}>
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
    </Row>
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
      setError(errorText(err));
    }
  };
  const step = info.status?.state === "running" ? info.status.step : "Starting";
  const notes = !busy && info.status?.state === "done" ? info.status.notes : [];

  return (
    <Group title="Updates">
      <Row label="Version">
        <span className="val">
          {info.current?.sha
            ? `${short(info.current.sha)}${info.current.subject ? ` ${info.current.subject}` : ""}`
            : "Unknown"}
        </span>
      </Row>
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
    </Group>
  );
}
