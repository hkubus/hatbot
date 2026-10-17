// Proxmox's settings: guests where every change asks first (power, and commands and files over SSH).
import { useState } from "react";
import { errorText } from "../api";
import { useLeaveGuard } from "../confirm";
import type { PluginSettingsProps } from ".";

type Config = { careful: number[] };

export function ProxmoxSettings({ config, save }: PluginSettingsProps<Config>) {
  const [text, setText] = useState(config.careful.join(", "));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const ids = text
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(Number);
  const valid = ids.every((n) => Number.isInteger(n) && n > 0);
  const changed = ids.join(",") !== config.careful.join(",");
  useLeaveGuard(changed);

  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      await save({ careful: ids });
    } catch (err) {
      setError(errorText(err, "Couldn't save"));
    }
    setBusy(false);
  };

  return (
    <div className="panel form">
      <label>
        <span className="label">Always ask before powering or changing these guests</span>
        <input
          className="field"
          value={text}
          placeholder="e.g. 100, 200"
          onChange={(e) => setText(e.target.value)}
        />
      </label>
      {!valid && <div className="form-error">Guest IDs are whole numbers, like 105.</div>}
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
