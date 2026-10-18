// Settings → Heartbeat: a look every few minutes at what went wrong; only news goes to Haiku.
import { type AppSettings, describeEvery, type HeartbeatInfo } from "@hatbot/shared";
import { Fragment, useEffect, useRef, useState } from "react";
import { useAction } from "../action";
import { api } from "../api";
import { BotPicker } from "../automations";
import { useLeaveGuard } from "../confirm";
import { plainText, stamp } from "../format";
import { LoadError, loadErrorText } from "../load";
import { navigate } from "../router";
import { useStore } from "../store";
import { Switch } from "../switch";
import { BackHead, SaveBar } from "../ui";

const EVERY = [5, 10, 15, 30, 60, 120, 360];
const DID: Record<string, string> = {
  nothing: "Let it be",
  notify: "Told you",
  task: "Started a task",
};

export function HeartbeatPage({ toast }: { toast: (t: string) => void }) {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [info, setInfo] = useState<HeartbeatInfo | null>(null);
  const [instructions, setInstructions] = useState("");
  const { busy, error, run } = useAction();
  const [loadError, setLoadError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const settingsVersion = useStore((s) => s.settingsVersion);
  const heartbeatVersion = useStore((s) => s.heartbeatVersion);
  // The instructions as saved: a change from elsewhere replaces them only if you haven't edited them.
  const savedInstructions = useRef<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refetch when settings change anywhere
  useEffect(() => {
    setLoadError("");
    api<AppSettings>("/settings").then(
      (s) => {
        setSettings(s);
        const was = savedInstructions.current;
        setInstructions((cur) => (was === null || cur === was ? s.heartbeat.instructions : cur));
        savedInstructions.current = s.heartbeat.instructions;
      },
      (err) => setLoadError(loadErrorText(err)),
    );
  }, [settingsVersion, attempt]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: refetch after each heartbeat
  useEffect(() => {
    api<HeartbeatInfo>("/heartbeat").then(setInfo, () => {});
  }, [heartbeatVersion]);
  const unsaved = settings !== null && instructions !== settings.heartbeat.instructions;
  useLeaveGuard(unsaved);

  if (!settings)
    return (
      <section className="view">
        {loadError && (
          <div className="page narrow">
            <LoadError error={loadError} retry={() => setAttempt((n) => n + 1)} />
          </div>
        )}
      </section>
    );
  const hb = settings.heartbeat;
  const save = (patch: Partial<AppSettings["heartbeat"]>) =>
    run(async () => {
      const s = await api<AppSettings>("/settings", {
        method: "PUT",
        body: { heartbeat: { ...hb, ...patch } },
      });
      setSettings(s);
      savedInstructions.current = s.heartbeat.instructions;
      toast("Saved");
    });
  const lookNow = () =>
    run(async () => setInfo(await api<HeartbeatInfo>("/heartbeat/run", { body: {} })));

  return (
    <section className="view">
      <div className="page narrow">
        <BackHead to="/settings" label="Settings">
          {/* It looks with what's saved: off while you have unsaved instructions. */}
          <button
            type="button"
            className="btn sm"
            disabled={busy || unsaved}
            title={unsaved ? "Save your changes first" : undefined}
            onClick={lookNow}
          >
            Look now
          </button>
        </BackHead>
        <div className="panel form">
          <div className="form-row">
            <span className="label">On</span>
            <Switch on={hb.enabled} onChange={(enabled) => save({ enabled })} />
          </div>
          <div className="form-row">
            <span className="label">Look</span>
            <select
              className="field"
              aria-label="Look"
              value={hb.everyMinutes}
              onChange={(e) => save({ everyMinutes: Number(e.target.value) })}
            >
              {(EVERY.includes(hb.everyMinutes) ? EVERY : [...EVERY, hb.everyMinutes])
                .sort((a, b) => a - b)
                .map((m) => (
                  <option key={m} value={m}>
                    {describeEvery(m)}
                  </option>
                ))}
            </select>
          </div>
          <BotPicker value={hb.botId} onChange={(botId) => save({ botId })} />
          <label>
            <span className="label">What you want done</span>
            <textarea
              className="field"
              rows={6}
              maxLength={4000}
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
            />
          </label>
          <SaveBar
            error={error}
            disabled={!instructions.trim() || instructions === hb.instructions}
            onSave={() => save({ instructions })}
          />
        </div>
        {info?.at && (
          <div className="panel">
            <h3 className="section-title">Last look</h3>
            <dl className="kv">
              <dt>When</dt>
              <dd>{stamp(info.at)}</dd>
              <dt>Found</dt>
              <dd>
                {info.found.length
                  ? info.found.map((f) => <div key={f}>{plainText(f)}</div>)
                  : "Nothing new"}
              </dd>
              {info.found.length > 0 && info.action && (
                <>
                  <dt>Did</dt>
                  <dd>
                    {info.taskId ? (
                      <button
                        type="button"
                        className="text-link"
                        onClick={() => navigate(`/tasks/${info.taskId}`)}
                      >
                        {DID[info.action]}
                      </button>
                    ) : (
                      DID[info.action]
                    )}
                    {info.note ? `: ${plainText(info.note)}` : ""}
                  </dd>
                </>
              )}
            </dl>
          </div>
        )}
        {info?.recent && info.recent.length > 0 && (
          <div className="panel">
            <h3 className="section-title">Recent finds</h3>
            <dl className="kv">
              {info.recent.map((r) => (
                <Fragment key={r.at}>
                  <dt>{stamp(r.at)}</dt>
                  <dd>
                    {r.found.map((f) => (
                      <div key={f}>{plainText(f)}</div>
                    ))}
                    <div className="muted">{DID[r.action] ?? r.action}</div>
                  </dd>
                </Fragment>
              ))}
            </dl>
          </div>
        )}
      </div>
    </section>
  );
}
