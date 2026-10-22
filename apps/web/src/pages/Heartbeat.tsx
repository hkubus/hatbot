import type { AppSettings, HeartbeatInfo } from "@hatbot/shared";
import { Fragment, useRef, useState } from "react";
import { useAction } from "../action";
import { api } from "../api";
import { BotPicker, EverySelect } from "../automations";
import { useLeaveGuard } from "../confirm";
import { plainText, stamp } from "../format";
import { Icon } from "../icons";
import { LoadError, PageLoad, useLoad } from "../load";
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
  const [instructions, setInstructions] = useState("");
  const { busy, error, run } = useAction();
  const looking = useAction();
  const setting = useAction();
  const settingsVersion = useStore((s) => s.settingsVersion);
  const heartbeatVersion = useStore((s) => s.heartbeatVersion);
  // The instructions as saved: a change from elsewhere replaces them only if you haven't edited them.
  const savedInstructions = useRef<string | null>(null);

  const {
    data: settings,
    setData: setSettings,
    ...load
  } = useLoad(
    () =>
      api<AppSettings>("/settings").then((s) => {
        const was = savedInstructions.current;
        setInstructions((cur) => (was === null || cur === was ? s.heartbeat.instructions : cur));
        savedInstructions.current = s.heartbeat.instructions;
        return s;
      }),
    [settingsVersion],
  );
  const looked = useLoad(() => api<HeartbeatInfo>("/heartbeat"), [heartbeatVersion]);
  const info = looked.data;
  const unsaved = settings !== null && instructions !== settings.heartbeat.instructions;
  useLeaveGuard(unsaved);

  if (!settings) return <PageLoad error={load.error} retry={load.retry} />;
  const hb = settings.heartbeat;
  const put = (patch: Partial<AppSettings["heartbeat"]>) => async () => {
    const s = await api<AppSettings>("/settings", {
      method: "PUT",
      body: { heartbeat: { ...hb, ...patch } },
    });
    setSettings(s);
    savedInstructions.current = s.heartbeat.instructions;
    toast("Saved");
  };
  // The switch and choices save as you set them; what you want done waits for Save.
  const set = (patch: Partial<AppSettings["heartbeat"]>) => setting.run(put(patch));
  const lookNow = () =>
    looking.run(async () =>
      looked.setData(await api<HeartbeatInfo>("/heartbeat/run", { body: {} })),
    );

  return (
    <section className="view">
      <div className="page narrow">
        <BackHead to="/schedules" label="Automations">
          {/* It looks with what's saved: off while you have unsaved instructions. */}
          <button
            type="button"
            className="btn sm"
            disabled={looking.busy || unsaved}
            title={unsaved ? "Save your changes first" : undefined}
            onClick={lookNow}
          >
            <Icon name="play" />
            {looking.busy ? "Checking…" : "Check now"}
          </button>
        </BackHead>
        {looking.error && <div className="form-error">{looking.error}</div>}
        <div className="panel form">
          <div className="form-row">
            <span className="label">Heartbeat</span>
            <Switch on={hb.enabled} onChange={(enabled) => set({ enabled })} />
          </div>
          <div className="form-row">
            <span className="label">Check every</span>
            <EverySelect
              label="Check every"
              value={hb.everyMinutes}
              options={EVERY}
              onChange={(everyMinutes) => set({ everyMinutes })}
            />
          </div>
          <BotPicker value={hb.botId} onChange={(botId) => set({ botId })} />
          {setting.error && <div className="form-error">{setting.error}</div>}
        </div>
        <div className="panel form">
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
            disabled={busy || !instructions.trim() || instructions === hb.instructions}
            onSave={() => run(put({ instructions }))}
          />
        </div>
        {looked.error && !info && <LoadError error={looked.error} retry={looked.retry} />}
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
