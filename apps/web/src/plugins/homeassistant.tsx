// Home Assistant's settings: entities that let someone in besides locks, alarms and covers, such as
// a gate on a switch. Every change to them always asks first.
import { useState } from "react";
import { ApiError } from "../api";
import type { PluginSettingsProps } from ".";

type Config = { access: string[] };

const ENTITY = /^[a-z0-9_]+\.[a-z0-9_]+$/;

export function HomeAssistantSettings({ config, save }: PluginSettingsProps<Config>) {
  const [text, setText] = useState(config.access.join(", "));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const ids = text
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const valid = ids.every((id) => ENTITY.test(id));
  const changed = ids.join(",") !== config.access.join(",");

  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      await save({ access: ids });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save");
    }
    setBusy(false);
  };

  return (
    <div className="panel form">
      <label>
        <span className="label">Always ask before changing these entities</span>
        <input
          className="field"
          value={text}
          placeholder="e.g. switch.gate, button.garage_open"
          onChange={(e) => setText(e.target.value)}
        />
      </label>
      {!valid && (
        <div className="form-error">Entity ids look like switch.gate: lowercase, with a dot.</div>
      )}
      {error && <div className="form-error">{error}</div>}
      <div className="form-actions">
        <button
          type="button"
          className="btn accent"
          disabled={busy || !valid || !changed}
          onClick={submit}
        >
          Save
        </button>
      </div>
    </div>
  );
}
