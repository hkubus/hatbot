// Settings → Heartbeat: a look every few minutes at what went wrong; only news goes to Haiku.
import { type AppSettings, describeEvery, type HeartbeatInfo } from "@hatbot/shared";
import { useEffect, useState } from "react";
import { ApiError, api } from "../api";
import { Icon } from "../icons";
import { navigate } from "../router";
import { Switch } from "../switch";
import { BotPicker, stamp } from "./Schedules";

const EVERY = [5, 10, 15, 30, 60, 120, 360];
const DID = { nothing: "Let it be", notify: "Told you", task: "Started a task" } as const;

export function HeartbeatPage({ toast }: { toast: (t: string) => void }) {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [info, setInfo] = useState<HeartbeatInfo | null>(null);
  const [instructions, setInstructions] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api<AppSettings>("/settings").then((s) => {
      setSettings(s);
      setInstructions(s.heartbeat.instructions);
    });
    api<HeartbeatInfo>("/heartbeat").then(setInfo, () => {});
  }, []);

  if (!settings) return <section className="view" />;
  const hb = settings.heartbeat;
  const save = async (patch: Partial<AppSettings["heartbeat"]>) => {
    setError("");
    try {
      const s = await api<AppSettings>("/settings", {
        method: "PUT",
        body: { heartbeat: { ...hb, ...patch } },
      });
      setSettings(s);
      toast("Saved");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save");
    }
  };
  const lookNow = async () => {
    setBusy(true);
    setError("");
    try {
      setInfo(await api<HeartbeatInfo>("/heartbeat/run", { body: {} }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't reach Hatbot.");
    }
    setBusy(false);
  };

  return (
    <section className="view">
      <div className="page narrow">
        <div className="page-head">
          <button type="button" className="btn sm ghost back" onClick={() => navigate("/settings")}>
            <Icon name="chevron" />
            Settings
          </button>
          <span className="spacer" />
          <button type="button" className="btn sm" disabled={busy} onClick={lookNow}>
            Look now
          </button>
        </div>
        <p className="muted">
          Every few minutes Hatbot looks over failed tasks, missed approvals, watchers and plugins
          that can't be read, monitors that are down, failing backups and spend, without the model.
          Only something new goes to Haiku, which tells you, starts a task, or lets it be.
        </p>
        <div className="panel form">
          <div className="form-row">
            <span className="label">On</span>
            <Switch on={hb.enabled} onChange={(enabled) => save({ enabled })} />
          </div>
          <div className="form-row">
            <span className="label">Look</span>
            <select
              className="field"
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
          {error && <div className="form-error">{error}</div>}
          <div className="form-actions">
            <button
              type="button"
              className="btn accent"
              disabled={!instructions.trim() || instructions === hb.instructions}
              onClick={() => save({ instructions })}
            >
              Save
            </button>
          </div>
        </div>
        {info?.at && (
          <div className="panel">
            <h3 className="section-title">Last look</h3>
            <dl className="kv">
              <dt>When</dt>
              <dd>{stamp(info.at)}</dd>
              <dt>Found</dt>
              <dd>
                {info.found.length ? info.found.map((f) => <div key={f}>{f}</div>) : "Nothing new"}
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
                    {info.note ? `: ${info.note}` : ""}
                  </dd>
                </>
              )}
            </dl>
          </div>
        )}
      </div>
    </section>
  );
}
