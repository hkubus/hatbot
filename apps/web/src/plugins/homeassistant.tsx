// Home Assistant's settings: entities that let someone in besides locks, alarms and covers, such as
// a gate on a switch, or a script or an integration's scene that opens one. Every change to them
// always asks first.
import { useState } from "react";
import { ApiError } from "../api";
import { useLeaveGuard } from "../confirm";
import type { PluginSettingsProps } from ".";

type Config = { access: string[] };

const ENTITY = /^[a-z0-9_]+\.[a-z0-9_]+$/;

export function HomeAssistantSettings({ config, save }: PluginSettingsProps<Config>) {
  const [text, setText] = useState(config.access.join(", "));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const ids = text
    .split(/[\s,]+/)
    // Home Assistant reads ids in any case as lowercase.
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const valid = ids.every((id) => ENTITY.test(id));
  const changed = ids.join(",") !== config.access.join(",");
  useLeaveGuard(changed);

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
        <span className="label">
          Always ask before changing these entities, such as scripts or scenes that open a door
        </span>
        <input
          className="field"
          value={text}
          placeholder="e.g. switch.gate, script.open_garage"
          onChange={(e) => setText(e.target.value)}
        />
      </label>
      {!valid && (
        <div className="form-error">
          Entity ids look like switch.gate: letters, digits and _, with a dot.
        </div>
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
