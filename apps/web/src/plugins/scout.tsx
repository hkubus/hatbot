import { useState } from "react";
import { useAction } from "../action";
import { errorText } from "../api";
import { useLeaveGuard } from "../confirm";
import { Panel } from "../ui";
import type { PluginSettingsProps } from ".";
import { useSignInReturn } from "./sign-in";

type Config = { url: string };

/** One button: it saves the address, switches the plugin on, and opens Scout to let Hatbot in. */
export function ScoutSettings({ config, save, action, running }: PluginSettingsProps<Config>) {
  const [url, setUrl] = useState(config.url);
  const { busy, error, setError, run } = useAction();
  const address = url.trim().replace(/\/+$/, "");
  const okUrl = /^https?:\/\/[^\s/]+$/.test(address);
  useLeaveGuard(address !== config.url);

  // Scout sends the browser back here once you've let Hatbot in.
  useSignInReturn("Scout", action, running, { run, setError });

  const connect = () =>
    run(
      async () => {
        if (address !== config.url || !running) await save({ url: address }, true);
        const { url: go } = await action<{ url: string }>("connect");
        location.assign(go);
      },
      (err) => setError(errorText(err, "Couldn't connect.")),
    );

  return (
    <Panel title="Scout" className="form">
      <label>
        <span className="label">Scout's address</span>
        <input
          className="field"
          placeholder="http://192.168.1.30:3001"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
      </label>
      {url.trim() !== "" && !okUrl && (
        <div className="form-error">Its address, like http://192.168.1.30:3001.</div>
      )}
      {error && <div className="form-error">{error}</div>}
      <div>
        <button type="button" className="btn primary" disabled={busy || !okUrl} onClick={connect}>
          {busy ? "Connecting…" : "Connect"}
        </button>
      </div>
    </Panel>
  );
}
