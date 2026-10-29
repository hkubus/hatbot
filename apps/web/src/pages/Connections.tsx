// Set here, the ntfy server replaces the host's (deploy.sh's) until removed. The token is only ever
// sent, never shown.
import type { ConnectionSource, Connections as ConnectionsInfo } from "@hatbot/shared";
import { type FormEvent, useState } from "react";
import { useAction } from "../action";
import { api, errorText } from "../api";
import { ask, useLeaveGuard } from "../confirm";
import { Link } from "../link";
import { LoadError, useLoad } from "../load";
import type { Toast } from "../toast";
import { BackHead } from "../ui";

const SOURCE: Record<Exclude<ConnectionSource, null>, string> = {
  app: "Set here",
  host: "From the host (deploy.sh)",
};

/** A topic like deploy.sh's: long and random, so nobody can guess it. */
function randomTopic() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return `hatbot-${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export function NtfyPage({ toast }: { toast: Toast }) {
  const {
    data: info,
    setData: setInfo,
    error,
    retry,
  } = useLoad(() => api<ConnectionsInfo>("/connections"), []);
  return (
    <section className="view">
      <div className="page narrow">
        <BackHead to="/settings" label="Settings" />
        {error && <LoadError error={error} retry={retry} />}
        {info && (
          <NtfyForm
            key={JSON.stringify(info.ntfy)}
            info={info.ntfy}
            onSaved={setInfo}
            toast={toast}
          />
        )}
      </div>
    </section>
  );
}

function NtfyForm({
  info,
  onSaved,
  toast,
}: {
  info: ConnectionsInfo["ntfy"];
  onSaved: (c: ConnectionsInfo) => void;
  toast: Toast;
}) {
  const [url, setUrl] = useState(info.url);
  const [topic, setTopic] = useState(info.topic);
  const [token, setToken] = useState("");
  const { busy, error, run } = useAction();
  const resetting = useAction();
  const changed = url !== info.url || topic !== info.topic || token !== "";
  useLeaveGuard(changed);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    run(async () => {
      onSaved(
        await api<ConnectionsInfo>("/connections/ntfy", {
          method: "PUT",
          body: { url, topic, ...(token ? { token } : {}) },
        }),
      );
      toast("Saved. Send a test approval from Notifications to try it.");
    });
  };

  // Back to the host's, which may have none.
  const reset = async () => {
    if (
      !(await ask({
        text: "Forget the ntfy server set here and use the host's?",
        ok: "Use the host's",
      }))
    )
      return;
    await resetting.run(
      async () => {
        onSaved(await api<ConnectionsInfo>("/connections/ntfy", { method: "DELETE" }));
        toast("Saved");
      },
      (err) => toast(errorText(err), "error"),
    );
  };

  return (
    <form className="panel form" onSubmit={submit}>
      <h3 className="section-title">ntfy server</h3>
      <div className="muted">
        {info.from
          ? `${SOURCE[info.from]}. `
          : "Not set: approvals and results only show in the app. "}
        Subscribe the ntfy app on your phone to the topic, and let only your ntfy user read it.{" "}
        <Link to="/settings/checks">Check everything</Link> tells you if anyone else can.
      </div>
      <label>
        <span className="label">Server</span>
        <input
          className="field"
          type="url"
          inputMode="url"
          autoComplete="off"
          placeholder="https://ntfy.example.com"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
      </label>
      <span className="label">Topic</span>
      <div className="form-row">
        <input
          className="field mono"
          aria-label="Topic"
          autoComplete="off"
          spellCheck={false}
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
        />
        <button type="button" className="btn sm" onClick={() => setTopic(randomTopic())}>
          Random
        </button>
      </div>
      <label>
        <span className="label">Access token, for an ntfy user that may publish to the topic</span>
        <input
          className="field mono"
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={info.tokenSet ? "Unchanged" : "tk_…"}
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />
      </label>
      {error && <div className="form-error">{error}</div>}
      <div className="form-actions">
        {info.from === "app" && (
          <button type="button" className="btn ghost" disabled={resetting.busy} onClick={reset}>
            Use the host's
          </button>
        )}
        <button type="submit" className="btn accent" disabled={busy || !changed || !url || !topic}>
          Save
        </button>
      </div>
    </form>
  );
}
