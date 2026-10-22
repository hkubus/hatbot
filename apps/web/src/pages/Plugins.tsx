// Secrets are only ever sent, never shown.
import type { PluginEnvInfo, PluginInfo } from "@hatbot/shared";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { useAction } from "../action";
import { api, errorText } from "../api";
import { ask } from "../confirm";
import { NoForm } from "../form";
import { PLUGIN_SETTINGS } from "../plugins";
import { loadPlugins, savePlugin, savePluginSecrets, useStore } from "../store";
import { Switch } from "../switch";
import { BackHead, Group, LinkRow } from "../ui";

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
    <Group title="Plugins">
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
          <LinkRow key={id} to={`/settings/plugins/${id}`} label={p.name}>
            <span className="val">{STATE[p.state]}</span>
          </LinkRow>
        );
      })}
    </Group>
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
        </div>

        {p.env.length > 0 && <EnvForm key={JSON.stringify(p.env)} p={p} toast={toast} />}
        {p.named && <NamedSecrets p={p} names={p.named} toast={toast} />}

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
          <Group title="Tools">
            {p.tools.map((t) => (
              <div className="row" key={t.name}>
                <div className="txt">
                  <b className="mono">{t.name}</b>
                </div>
                <span className="val">{t.access === "read" ? "Reads" : "Changes"}</span>
              </div>
            ))}
          </Group>
        )}
      </div>
    </section>
  );
}

const SOURCE = { app: "Set here", host: "From the host's env file" };

/** What the plugin reads from the environment: each set here wins over the host's. */
function EnvForm({ p, toast }: { p: PluginInfo; toast: (t: string) => void }) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(p.env.map((v) => [v.name, v.value ?? ""])),
  );
  const { busy, error, run } = useAction();
  const changes = Object.fromEntries(
    p.env
      .filter((v) => (values[v.name] ?? "").trim() !== (v.value ?? ""))
      .map((v) => [v.name, (values[v.name] ?? "").trim()]),
  );
  // Emptying one set here forgets it; one the host set can't be emptied from here.
  const forgets = Object.entries(changes).filter(([, value]) => !value);
  const bad = forgets.some(([name]) => p.env.find((v) => v.name === name)?.from !== "app");

  const send = (values: Record<string, string | null>) =>
    run(async () => {
      await savePluginSecrets(p.id, values);
      toast(p.enabled ? `Saved; ${p.name} restarted with it.` : "Saved");
    });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    send(Object.fromEntries(Object.entries(changes).map(([n, v]) => [n, v || null])));
  };
  const forget = async (v: PluginEnvInfo) => {
    if (
      await ask({ text: `Forget the ${v.name} set here and use the host's?`, ok: "Use the host's" })
    )
      send({ [v.name]: null });
  };

  return (
    <form className="panel form" onSubmit={submit}>
      <h3 className="section-title">Connection</h3>
      {p.env.map((v) => (
        <div key={v.name}>
          <span className="label">
            <span className="mono">{v.name}</span>
            {v.optional && " (optional)"} ·{" "}
            {v.from ? SOURCE[v.from] : v.optional ? "Not set" : "Missing"}
          </span>
          <div className="form-row">
            <input
              className="field mono"
              aria-label={v.name}
              type={v.secret ? "password" : "text"}
              autoComplete="off"
              spellCheck={false}
              placeholder={v.secret && v.set ? "Unchanged" : (v.hint ?? "")}
              value={values[v.name] ?? ""}
              onChange={(e) => setValues({ ...values, [v.name]: e.target.value })}
            />
            {v.from === "app" && (
              <button
                type="button"
                className="btn sm ghost"
                disabled={busy}
                onClick={() => forget(v)}
              >
                Use the host's
              </button>
            )}
          </div>
        </div>
      ))}
      {bad && (
        <div className="form-error">
          A value from the host's env file can only be replaced here.
        </div>
      )}
      {error && <div className="form-error">{error}</div>}
      <div className="form-actions">
        <button
          type="submit"
          className="btn accent"
          disabled={busy || bad || !Object.keys(changes).length}
        >
          Save
        </button>
      </div>
    </form>
  );
}

/** Secrets by any name, for a plugin that takes them: MCP's ${NAME}. */
function NamedSecrets({
  p,
  names,
  toast,
}: {
  p: PluginInfo;
  names: string[];
  toast: (t: string) => void;
}) {
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const { busy, error, run } = useAction();
  const add = (e: FormEvent) => {
    e.preventDefault();
    run(async () => {
      await savePluginSecrets(p.id, { [name.trim()]: value });
      setName("");
      setValue("");
      toast("Saved");
    });
  };
  const remove = async (n: string) => {
    if (await ask({ text: `Remove ${n}? Servers that use it stop connecting.`, ok: "Remove" }))
      run(async () => {
        await savePluginSecrets(p.id, { [n]: null });
        toast("Removed");
      });
  };

  return (
    <form className="panel form" onSubmit={add}>
      <h3 className="section-title">Secrets</h3>
      <div className="muted">
        A server's headers and environment use one as ${"{NAME}"}. Names set in /etc/hatbot/mcp.env
        on the brain work too.
      </div>
      {names.map((n) => (
        <div className="form-row" key={n}>
          <span className="mono">{n}</span>
          <button type="button" className="btn sm ghost" disabled={busy} onClick={() => remove(n)}>
            Remove
          </button>
        </div>
      ))}
      <div className="form-row">
        <input
          className="field mono"
          aria-label="Name"
          autoComplete="off"
          spellCheck={false}
          placeholder="NAME"
          value={name}
          onChange={(e) => setName(e.target.value.toUpperCase())}
        />
        <input
          className="field mono"
          aria-label="Value"
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder="Value"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
      </div>
      {error && <div className="form-error">{error}</div>}
      <div className="form-actions">
        <button
          type="submit"
          className="btn accent"
          disabled={busy || !name.trim() || !value.trim()}
        >
          {names.includes(name.trim()) ? "Replace" : "Add"}
        </button>
      </div>
    </form>
  );
}
