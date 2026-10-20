// Claude Code's settings: the model it works with and how long one run may take.
import { useState } from "react";
import { useAction } from "../action";
import { errorText } from "../api";
import { useLeaveGuard } from "../confirm";
import { SaveBar, Seg } from "../ui";
import type { PluginSettingsProps } from ".";

type Model = "opus" | "sonnet" | "haiku";
type Config = { model: Model; minutes: number };

const MODELS = [
  ["opus", "Opus"],
  ["sonnet", "Sonnet"],
  ["haiku", "Haiku"],
] as const;

export function ClaudeSettings({ config, save }: PluginSettingsProps<Config>) {
  const [model, setModel] = useState(config.model);
  const [minutes, setMinutes] = useState(String(config.minutes));
  const { busy, error, setError, run } = useAction();
  const n = Number(minutes);
  const ok = Number.isInteger(n) && n >= 5 && n <= 120;
  const changed = model !== config.model || n !== config.minutes;
  useLeaveGuard(changed);

  const submit = () =>
    run(
      () => save({ model, minutes: n }),
      (err) => setError(errorText(err, "Couldn't save")),
    );

  return (
    <div className="panel form">
      <span className="label">Model</span>
      <Seg<Model> value={model} options={MODELS} onChange={setModel} />
      <label>
        <span className="label">Minutes a run may take</span>
        <input
          className="field"
          type="number"
          min={5}
          max={120}
          value={minutes}
          onChange={(e) => setMinutes(e.target.value)}
        />
      </label>
      {!ok && <div className="form-error">From 5 to 120 minutes.</div>}
      <SaveBar error={error} disabled={busy || !ok || !changed} onSave={submit} />
    </div>
  );
}
