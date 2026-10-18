// Plugins in Settings (PLAN.md §4.5): the list, and a page per plugin with its switch, secrets,
// settings and Test button.
import type { PluginInfo } from "@hatbot/shared";
import { useCallback, useEffect, useState } from "react";
import { useAction } from "../action";
import { api, errorText } from "../api";
import { NoForm } from "../form";
import { Icon } from "../icons";
import { PLUGIN_SETTINGS } from "../plugins";
import { navigate } from "../router";
import { loadPlugins, savePlugin, useStore } from "../store";
import { Switch } from "../switch";
import { BackHead } from "../ui";

const STATE: Record<PluginInfo["state"], string> = {
  off: "Off",
  starting: "Starting",
  ready: "On",
  needs_setup: "Needs setup",
  error: "Error",
};

export function PluginsGroup() {
  const [ids, setIds] = useState<string[] | null>(null);
  const [error, setError] = useState("");
  const plugins = useStore((s) => s.plugins);
  const load = useCallback(() => {
    setError("");
    loadPlugins().then(setIds, (err) => setError(errorText(err)));
  }, []);
  useEffect(load, [load]);
  if (!error && !ids?.length) return null;
  return (
    <section className="group">
      <h2>Plugins</h2>
      <div className="group-box">
        {error && (
          <div className="row">
            <div className="txt">
              <span className="form-error">{error}</span>
            </div>
            <button type="button" className="btn sm" onClick={load}>
              Retry
            </button>
          </div>
        )}
        {(ids ?? []).map((id) => {
          const p = plugins[id];
          if (!p) return null;
          return (
            <button
              type="button"
              key={id}
              className="row link"
              onClick={() => navigate(`/settings/plugins/${id}`)}
            >
              <div className="txt">
                <b>{p.name}</b>
              </div>
              <span className="val">{STATE[p.state]}</span>
              <Icon name="chevron" className="chev" />
            </button>
          );
        })}
      </div>
    </section>
  );
}

export function PluginPage({ id, toast }: { id: string; toast: (t: string) => void }) {
  const p = useStore((s) => s.plugins[id]);
  const { error, setError, run } = useAction();
  const testing = useAction();
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  /** The switch as you just set it, until the brain answers. */
  const [turning, setTurning] = useState<boolean | null>(null);
  const [loaded, setLoaded] = useState(false);
  const action = useCallback(
    async <T,>(name: string, args: unknown = {}) =>
      (await api<{ result: T }>(`/plugins/${id}/actions/${name}`, { body: args })).result,
    [id],
  );
  const load = useCallback(() => {
    setError("");
    loadPlugins().then(
      () => setLoaded(true),
      (err) => setError(errorText(err)),
    );
  }, [setError]);

  useEffect(() => {
    if (!p) load();
  }, [p, load]);

  if (!p)
    return (
      <NoForm
        error={error}
        missing={loaded ? "This plugin doesn't exist." : ""}
        retry={load}
        back={{ label: "Settings", to: "/settings" }}
      />
    );

  const Settings = PLUGIN_SETTINGS[p.id];
  const toggle = async (enabled: boolean) => {
    setResult(null);
    // It flips at once; a failed save flips it back.
    setTurning(enabled);
    await run(() => savePlugin(p.id, { enabled }));
    setTurning(null);
  };
  const save = async (config: unknown) => {
    await savePlugin(p.id, { config });
    toast("Saved");
  };

  const test = () => {
    setResult(null);
    void testing.run(
      async () => setResult(await api<typeof result>(`/plugins/${p.id}/test`, { body: {} })),
      (err) => setResult({ ok: false, message: errorText(err) }),
    );
  };

  return (
    <section className="view">
      <div className="page narrow">
        <BackHead to="/settings" label="Settings">
          {p.testable && p.state === "ready" && (
            <button type="button" className="btn sm" disabled={testing.busy} onClick={test}>
              {testing.busy ? "Testing…" : "Test"}
            </button>
          )}
        </BackHead>

        <div className="panel form">
          <div className="form-row">
            <span className="label">{p.name}</span>
            <Switch on={turning ?? p.enabled} onChange={toggle} />
          </div>
          {p.message && <div className="form-error">{p.message}</div>}
          {error && <div className="form-error">{error}</div>}
          {result && <div className={result.ok ? "" : "form-error"}>{result.message}</div>}
          {p.secrets.length > 0 && (
            <dl className="kv secrets">
              {p.secrets.map((s) => (
                <SecretRow key={s.name} name={s.name} set={s.set} />
              ))}
            </dl>
          )}
        </div>

        {Settings && (
          <Settings
            key={JSON.stringify(p.config)}
            config={p.config}
            save={save}
            action={action}
            running={p.state === "ready" || p.state === "needs_setup"}
          />
        )}

        {p.tools.length > 0 && (
          <section className="group">
            <h2>Tools</h2>
            <div className="group-box">
              {p.tools.map((t) => (
                <div className="row" key={t.name}>
                  <div className="txt">
                    <b className="mono">{t.name}</b>
                  </div>
                  <span className="val">{t.access === "read" ? "Reads" : "Changes"}</span>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </section>
  );
}

function SecretRow({ name, set }: { name: string; set: boolean }) {
  return (
    <>
      <dt className="mono">{name}</dt>
      <dd>{set ? "Set" : "Missing"}</dd>
    </>
  );
}
