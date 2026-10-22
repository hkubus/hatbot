// Set here, the API key and ntfy server replace the host's (deploy.sh's) until removed. The key and
// the token are only ever sent, never shown.
import type { ConnectionSource, Connections as ConnectionsInfo } from "@hatbot/shared";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { useAction } from "../action";
import { api, errorText } from "../api";
import { ask } from "../confirm";
import { Link } from "../link";
import { LoadError } from "../load";
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

export function Connections({ toast }: { toast: Toast }) {
  const [info, setInfo] = useState<ConnectionsInfo | null>(null);
  const [loadError, setLoadError] = useState("");
  const load = useCallback(() => {
    setLoadError("");
    api<ConnectionsInfo>("/connections").then(setInfo, (err) => setLoadError(errorText(err)));
  }, []);
  useEffect(load, [load]);

  return (
    <section className="view">
      <div className="page narrow">
        <BackHead to="/settings" label="Settings" />
        {loadError && <LoadError error={loadError} retry={load} />}
        {info && (
          <>
            <ApiKeyForm info={info.anthropic} onSaved={setInfo} toast={toast} />
            <NtfyForm
              key={JSON.stringify(info.ntfy)}
              info={info.ntfy}
              onSaved={setInfo}
              toast={toast}
            />
          </>
        )}
      </div>
    </section>
  );
}

/** Back to the host's: asks first, since the host may have none. */
function useHosts(what: string, path: string, onSaved: (c: ConnectionsInfo) => void, toast: Toast) {
  const { busy, run } = useAction();
  const reset = async () => {
    if (
      !(await ask({
        text: `Forget the ${what} set here and use the host's?`,
        ok: "Use the host's",
      }))
    )
      return;
    await run(
      async () => {
        onSaved(await api<ConnectionsInfo>(path, { method: "DELETE" }));
        toast("Saved");
      },
      (err) => toast(errorText(err), "error"),
    );
  };
  return { busy, reset };
}

function ApiKeyForm({
  info,
  onSaved,
  toast,
}: {
  info: ConnectionsInfo["anthropic"];
  onSaved: (c: ConnectionsInfo) => void;
  toast: Toast;
}) {
  const [key, setKey] = useState("");
  const { busy, error, run } = useAction();
  const hosts = useHosts("API key", "/connections/anthropic", onSaved, toast);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    run(async () => {
      onSaved(
        await api<ConnectionsInfo>("/connections/anthropic", { method: "PUT", body: { key } }),
      );
      setKey("");
      toast("Saved. Chats and tasks use the new key from now on.");
    });
  };

  return (
    <form className="panel form" onSubmit={submit}>
      <h3 className="section-title">Anthropic API key</h3>
      <div className="muted">
        {info.set && info.from
          ? `${SOURCE[info.from]}${info.ending ? `, ending in ${info.ending}` : ""}.`
          : "Not set: chats and tasks fail until there's one."}
      </div>
      <label>
        <span className="label">{info.set ? "New key" : "Key"}</span>
        <input
          className="field mono"
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder="sk-ant-…"
          value={key}
          onChange={(e) => setKey(e.target.value)}
        />
      </label>
      {error && <div className="form-error">{error}</div>}
      <div className="form-actions">
        {info.from === "app" && (
          <button type="button" className="btn ghost" disabled={hosts.busy} onClick={hosts.reset}>
            Use the host's
          </button>
        )}
        <button type="submit" className="btn accent" disabled={busy || !key.trim()}>
          {busy ? "Trying it…" : "Try and save"}
        </button>
      </div>
    </form>
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
  const hosts = useHosts("ntfy server", "/connections/ntfy", onSaved, toast);
  const changed = url !== info.url || topic !== info.topic || token !== "";

  const submit = (e: FormEvent) => {
    e.preventDefault();
    run(async () => {
      onSaved(
        await api<ConnectionsInfo>("/connections/ntfy", {
          method: "PUT",
          body: { url, topic, ...(token ? { token } : {}) },
        }),
      );
      toast("Saved. Send a test approval from Check everything to try it.");
    });
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
          <button type="button" className="btn ghost" disabled={hosts.busy} onClick={hosts.reset}>
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
