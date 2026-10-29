import type {
  Approval,
  ApprovalRule,
  AppSettings,
  ChecksInfo,
  Limits,
  UpdateInfo,
} from "@hatbot/shared";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useAction } from "../action";
import { api, errorText } from "../api";
import { ask } from "../confirm";
import { clearDrafts } from "../drafts";
import { prTitle, shortSha, stamp } from "../format";
import { LoadError, PageLoad, useLoad } from "../load";
import { chatModelOptions, modelNameIn, modelOptions, useModels } from "../models";
import { navigate } from "../router";
import { parseLimit, parseName, SavedRow } from "../saved-row";
import { pluginOn, setPaused, useStore } from "../store";
import { Switch } from "../switch";
import { setTheme, useTheme } from "../theme";
import type { Toast } from "../toast";
import { BackHead, Disclosure, EFFORTS, Group, LinkRow, Row, Seg, Select } from "../ui";
import { RoutinesGroup } from "./BuiltIn";
import { AddPluginPage, PluginPage, PluginsPage } from "./Plugins";
import { SafetyPage } from "./Safety";

const Account = lazy(() => import("./Account").then((m) => ({ default: m.Account })));
const Checks = lazy(() => import("./Checks").then((m) => ({ default: m.Checks })));
const Devices = lazy(() => import("./Devices").then((m) => ({ default: m.Devices })));
const NtfyPage = lazy(() => import("./Connections").then((m) => ({ default: m.NtfyPage })));

/** Old addresses, for bookmarks and links from before the regroup. */
const MOVED: Record<string, string> = {
  "/settings/heartbeat": "/schedules/heartbeat",
  "/settings/connections": "/settings/plugins/anthropic",
  "/settings/api-key": "/settings/plugins/anthropic",
};

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
  const moved = MOVED[path];
  useEffect(() => {
    if (moved) navigate(moved, true);
  }, [moved]);
  if (moved) return null;
  const plugin = /^\/settings\/plugins\/([a-z0-9]+)$/.exec(path)?.[1];
  const page = plugin ? (
    <PluginPage key={plugin} id={plugin} toast={toast} />
  ) : path === "/settings/plugins" ? (
    <PluginsPage />
  ) : path === "/settings/add-plugin" ? (
    <AddPluginPage toast={toast} />
  ) : path === "/settings/account" ? (
    <Account toast={toast} />
  ) : path === "/settings/devices" ? (
    <Devices toast={toast} />
  ) : path === "/settings/notifications" ? (
    <NtfyPage toast={toast} />
  ) : path === "/settings/safety" ? (
    <SafetyPage toast={toast} />
  ) : path === "/settings/allowed" ? (
    <AllowedPage />
  ) : path === "/settings/checks" ? (
    <Checks />
  ) : null;
  if (page) return <Suspense fallback={<section className="view" />}>{page}</Suspense>;
  return <SettingsHome toast={toast} onSignOut={onSignOut} />;
}

const LIMITS = [
  ["dailyUsd", "Per day"],
  ["monthlyUsd", "Per month"],
] as const;
const MORE_LIMITS = [
  ["researchUsd", "Per research task"],
  ["boxesUsd", "Boxes per day"],
  ["alertReserveUsd", "Kept for alerts"],
] as const;

function SettingsHome({ toast, onSignOut }: { toast: Toast; onSignOut: () => void }) {
  const [rules, setRules] = useState<number | null>(null);
  const theme = useTheme();
  const models = useModels();
  const paused = useStore((s) => s.paused);
  const boxes = useStore((s) => pluginOn(s.plugins, "boxes"));
  const desktop = useStore((s) => pluginOn(s.plugins, "desktop"));
  // Saved elsewhere (the app, another tab): shown here too.
  const settingsVersion = useStore((s) => s.settingsVersion);
  const {
    data: settings,
    setData: setSettings,
    ...load
  } = useLoad(() => api<AppSettings>("/settings"), [settingsVersion]);
  useEffect(() => {
    api<ApprovalRule[]>("/approval-rules").then(
      (r) => setRules(r.length),
      () => {},
    );
  }, []);
  // Spend's Limits opens /settings#spending.
  const loaded = settings !== null;
  useEffect(() => {
    if (loaded && location.hash === "#spending")
      document.getElementById("spending")?.scrollIntoView({ block: "start" });
  }, [loaded]);

  /** Rejects with the brain's message, for a field to show beside itself. */
  const put = async (patch: Patch) => {
    setSettings(await api<AppSettings>("/settings", { method: "PUT", body: patch }));
    toast("Saved");
  };
  const update = (patch: Partial<AppSettings>) =>
    put(patch).catch((err) => toast(errorText(err, "Couldn't save."), "error"));

  const pausing = useAction();
  const pause = (on: boolean) =>
    pausing.run(async () => {
      await setPaused(on);
      toast(on ? "All activity paused" : "Resumed");
    });

  const signOut = async () => {
    await api("/auth/logout", { body: {} }).catch(() => {});
    clearDrafts();
    onSignOut();
  };

  if (!settings) return <PageLoad wide error={load.error} retry={load.retry} />;

  const limitRow = ([key, label]: (typeof LIMITS | typeof MORE_LIMITS)[number]) => {
    // Nothing kept for alerts is allowed, and boxes asking nothing; a limit of nothing isn't.
    const zero = key === "alertReserveUsd" || key === "boxesUsd";
    return (
      <SavedRow
        key={key}
        label={label}
        saved={settings.limits[key]}
        parse={(text) => parseLimit(text, zero)}
        save={(n) => put({ limits: { [key]: n } })}
        prefix="$"
        input={{ type: "number", inputMode: "decimal", min: zero ? "0" : "0.01", step: "0.01" }}
      />
    );
  };

  return (
    <section className="view">
      <div className="page">
        {boxes && (
          <Group className="show-phone">
            <LinkRow to="/boxes" label="Boxes" />
          </Group>
        )}

        <Group title="Models">
          <Row label="Chat">
            <Select
              label="Chat model"
              value={settings.chatModel}
              options={chatModelOptions(models, settings.chatModel, settings.expertModel)}
              onChange={(chatModel) => update({ chatModel })}
            />
          </Row>
          <Row label="Chat effort">
            <Select
              label="Chat effort"
              value={settings.chatEffort}
              options={EFFORTS}
              onChange={(chatEffort) => update({ chatEffort })}
            />
          </Row>
          <Row label="Background tasks">
            <Select
              label="Model for background tasks"
              value={settings.taskModel}
              options={modelOptions(models, settings.taskModel)}
              onChange={(taskModel) => update({ taskModel })}
            />
          </Row>
          {desktop && (
            <Row label="Desktop tasks">
              <Select
                label="Model for desktop tasks"
                value={settings.desktopModel}
                options={modelOptions(models, settings.desktopModel, (m) => m.computerUse)}
                onChange={(desktopModel) => update({ desktopModel })}
              />
            </Row>
          )}
          <Row label="Quick jobs">
            <Select
              label="Model for quick jobs"
              value={settings.smallModel}
              options={modelOptions(models, settings.smallModel)}
              onChange={(smallModel) => update({ smallModel })}
            />
          </Row>
          <Row label="Hard parts">
            <Select
              label="Model for hard parts"
              value={settings.expertModel}
              options={modelOptions(models, settings.expertModel)}
              onChange={(expertModel) => update({ expertModel })}
            />
          </Row>
          {desktop &&
            settings.desktopModel !== settings.expertModel &&
            models?.find((m) => m.id === settings.expertModel)?.computerUse && (
              <Row
                label={`Try desktop tasks again on ${modelNameIn(models, settings.expertModel)} when they fail`}
              >
                <Switch
                  on={settings.desktopEscalate}
                  onChange={(desktopEscalate) => update({ desktopEscalate })}
                />
              </Row>
            )}
        </Group>

        <RoutinesGroup settings={settings} update={update} />

        <div id="spending">
          <Group title="Spending">
            {LIMITS.map(limitRow)}
            <Disclosure label="More limits">{MORE_LIMITS.map(limitRow)}</Disclosure>
          </Group>
        </div>

        <Group title="Notifications">
          <LinkRow to="/settings/notifications" label="ntfy server" />
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
          <TestApprovalRow />
        </Group>

        <Group title="Safety">
          <LinkRow to="/settings/safety" label="Approvals and guardrails" />
          <LinkRow to="/settings/allowed" label="Always allowed">
            {rules !== null && <span className="val">{rules || "None"}</span>}
          </LinkRow>
        </Group>

        <Group title="Integrations">
          <LinkRow to="/settings/plugins" label="Plugins" />
        </Group>

        <Group title="Account">
          <SavedRow
            label="Your name on memory edits"
            saved={settings.owner.name}
            parse={parseName}
            save={(name) => put({ owner: { ...settings.owner, name } })}
            input={{ type: "text" }}
          />
          <LinkRow to="/settings/account" label="Password and authenticator" />
          <LinkRow to="/settings/devices" label="Devices and tokens" />
          <Row label="Sign out">
            <button type="button" className="btn sm" onClick={signOut}>
              Sign out
            </button>
          </Row>
        </Group>

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

        <Group title="System">
          <Row
            label="Pause all activity"
            sub={pausing.error && <span className="form-error">{pausing.error}</span>}
          >
            <Switch on={paused} onChange={pause} />
          </Row>
          <LinkRow to="/settings/checks" label="Check everything" />
          <UpdateRow toast={toast} />
          <RollbackRow toast={toast} />
        </Group>
      </div>
    </section>
  );
}

const ANSWER: Record<Approval["status"], string> = {
  pending: "Waiting for your answer",
  blocked: "Blocked",
  sending: "Sending",
  approved: "Approved",
  denied: "Denied",
  expired: "Expired",
  cancelled: "Replaced",
};

function TestApprovalRow() {
  const [approval, setApproval] = useState<Approval | null>(null);
  const live = useStore((s) => (approval ? s.approvals[approval.id] : undefined));
  const [error, setError] = useState("");
  useEffect(() => {
    api<ChecksInfo>("/checks").then(
      (info) => setApproval(info.approval),
      () => {},
    );
  }, []);
  const send = async () => {
    setError("");
    try {
      setApproval(await api<Approval>("/checks/approval", { body: {} }));
    } catch (err) {
      setError(errorText(err));
    }
  };
  const shown = live ?? approval;
  return (
    <Row
      label="Test approval"
      sub={
        error ? (
          <span className="form-error">{error}</span>
        ) : (
          shown && (
            <span>
              {ANSWER[shown.status]}
              {shown.decidedVia === "ntfy" ? " from the notification" : ""}
              {shown.decidedAt ? `, ${stamp(shown.decidedAt)}` : ""}
            </span>
          )
        )
      }
    >
      <button type="button" className="btn sm" onClick={send}>
        Send
      </button>
    </Row>
  );
}

function AllowedPage() {
  const {
    data: rules,
    setData: setRules,
    ...load
  } = useLoad(() => api<ApprovalRule[]>("/approval-rules"), []);
  const [error, setError] = useState("");
  const bots = useStore((s) => s.bots);
  const remove = async (r: ApprovalRule) => {
    setError("");
    try {
      await api(`/approval-rules/${r.id}`, { method: "DELETE" });
      setRules((rules ?? []).filter((x) => x.id !== r.id));
    } catch (err) {
      setError(errorText(err));
    }
  };
  return (
    <section className="view">
      <div className="page narrow">
        <BackHead to="/settings" label="Settings" />
        {load.error && <LoadError error={load.error} retry={load.retry} />}
        {error && <div className="form-error">{error}</div>}
        {rules && (
          <Group empty={!rules.length && "None yet. Approve something with Always to add it."}>
            {rules.map((r) => (
              <Row key={r.id} label={<span className="mono">{r.summary}</span>}>
                {r.botId !== "hatbot" && <span className="val">{bots[r.botId]?.name}</span>}
                {r.schedule && <span className="val">In {r.schedule}</span>}
                <button type="button" className="btn sm danger-text" onClick={() => remove(r)}>
                  Remove
                </button>
              </Row>
            ))}
          </Group>
        )}
      </div>
    </section>
  );
}

type Snapshot = { name: string; description: string; createdAt: string | null };

const snapLabel = (s: Snapshot) => (s.createdAt ? stamp(s.createdAt) : s.name);

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
      (err) => toast(errorText(err, "Couldn't roll back."), "error"),
    );
  };

  return (
    <Disclosure label="Advanced">
      <Row label="Roll back desktop" sub={error && <span className="form-error">{error}</span>}>
        {snaps.length > 0 ? (
          <>
            <Select
              label="Snapshot"
              value={picked}
              options={snaps.map((s) => [s.name, snapLabel(s)] as const)}
              onChange={setPicked}
              disabled={busy}
            />
            <button type="button" className="btn sm danger-text" disabled={busy} onClick={rollback}>
              {busy ? "Rolling back…" : "Roll back"}
            </button>
          </>
        ) : (
          !error && <span className="val">No snapshots yet</span>
        )}
      </Row>
    </Disclosure>
  );
}

function UpdateRow({ toast }: { toast: Toast }) {
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
            toast(`Updated to ${shortSha(next.current?.sha)}`);
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
    <div className="row update">
      <div className="txt">
        <b>Software update</b>
        {error && <span className="form-error">{error}</span>}
        {notes.map((n) => (
          <span key={n}>{n}</span>
        ))}
      </div>
      <span className="val">
        {info.current?.sha
          ? `${shortSha(info.current.sha)}${info.current.subject ? ` ${prTitle(info.current.subject)}` : ""}`
          : "Unknown"}
      </span>
      {info.source ? (
        <button type="button" className="btn sm" disabled={busy} onClick={update}>
          {busy ? `${step}…` : "Update"}
        </button>
      ) : (
        <span className="val">Not set up</span>
      )}
    </div>
  );
}
