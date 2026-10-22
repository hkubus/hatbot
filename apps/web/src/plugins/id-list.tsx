import { useState } from "react";
import { useAction } from "../action";
import { errorText } from "../api";
import { useLeaveGuard } from "../confirm";
import { SaveBar } from "../ui";
import type { PluginSettingsProps } from ".";

export function IdListSettings<K extends string, T extends string | number>({
  config,
  save,
  field,
  label,
  placeholder,
  parse,
  valid,
  invalid,
}: PluginSettingsProps<Record<K, T[]>> & {
  field: K;
  label: string;
  placeholder: string;
  parse: (text: string) => T;
  valid: (id: T) => boolean;
  /** What an id looks like, shown while one doesn't. */
  invalid: string;
}) {
  const saved = config[field];
  const [text, setText] = useState(saved.join(", "));
  const { busy, error, setError, run } = useAction();
  const ids = text
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(parse);
  const ok = ids.every(valid);
  const changed = ids.join(",") !== saved.join(",");
  useLeaveGuard(changed);

  const submit = () =>
    run(
      () => save({ [field]: ids } as Record<K, T[]>),
      (err) => setError(errorText(err, "Couldn't save.")),
    );

  return (
    <div className="panel form">
      <label>
        <span className="label">{label}</span>
        <input
          className="field"
          value={text}
          placeholder={placeholder}
          onChange={(e) => setText(e.target.value)}
        />
      </label>
      {!ok && <div className="form-error">{invalid}</div>}
      <SaveBar error={error} disabled={busy || !ok || !changed} onSave={submit} />
    </div>
  );
}
