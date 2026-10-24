import { useState } from "react";
import { useAction } from "../action";
import { errorText } from "../api";
import { useLeaveGuard } from "../confirm";
import { Panel, SaveBar, Seg } from "../ui";
import type { PluginSettingsProps } from ".";
import { useSignInReturn } from "./sign-in";

type Model = "opus" | "haiku";
type Config = { url: string; model: Model; minutes: number };

const MODELS = [
  ["opus", "Opus"],
  ["haiku", "Haiku"],
] as const;

export function T3Settings({ config, save, action, running }: PluginSettingsProps<Config>) {
  const [url, setUrl] = useState(config.url);
  const [model, setModel] = useState(config.model);
  const [minutes, setMinutes] = useState(String(config.minutes));
  const { busy, error, setError, run } = useAction();
  const n = Number(minutes);
  const okMinutes = Number.isInteger(n) && n >= 5 && n <= 240;
  const okUrl = url === "" || /^https?:\/\/[^\s/]+\/?$/.test(url.trim());
  const changed = url.trim() !== config.url || model !== config.model || n !== config.minutes;
  useLeaveGuard(changed);

  // T3 Code sends the browser back here once you've let Hatbot in.
  useSignInReturn("T3 Code", action, running, { run, setError });

  const submit = () =>
    run(
      () => save({ url: url.trim().replace(/\/+$/, ""), model, minutes: n }),
      (err) => setError(errorText(err, "Couldn't save.")),
    );

  const connect = () =>
    run(
      async () => {
        const { url: go } = await action<{ url: string }>("connect");
        location.assign(go);
      },
      (err) => setError(errorText(err, "Couldn't connect.")),
    );

  return (
    <Panel title="T3 Code" className="form">
      <label>
        <span className="label">T3 Code's address</span>
        <input
          className="field"
          placeholder="http://192.168.1.20:3773"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
      </label>
      {!okUrl && <div className="form-error">Its address, like http://192.168.1.20:3773.</div>}
      <span className="label">Model</span>
      <Seg<Model> value={model} options={MODELS} onChange={setModel} />
      <label>
        <span className="label">Minutes a run may take</span>
        <input
          className="field"
          type="number"
          min={5}
          max={240}
          value={minutes}
          onChange={(e) => setMinutes(e.target.value)}
        />
      </label>
      {!okMinutes && <div className="form-error">From 5 to 240 minutes.</div>}
      <SaveBar error={error} disabled={busy || !okMinutes || !okUrl || !changed} onSave={submit} />
      <span className="label">Sign-in, for 30 days; allow full access in T3 Code</span>
      <div>
        <button
          type="button"
          className="btn"
          disabled={busy || changed || !config.url || !running}
          onClick={connect}
        >
          Connect
        </button>
      </div>
    </Panel>
  );
}
