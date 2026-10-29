// Secrets are only ever sent, never shown.
import type { AppSettings, PluginEnvInfo, PluginIndexEntry, PluginInfo } from "@hatbot/shared";
import { type FormEvent, useMemo, useState } from "react";
import { useAction } from "../action";
import { api, errorText } from "../api";
import { ask, useLeaveGuard } from "../confirm";
import { Icon } from "../icons";
import { Link } from "../link";
import { LoadError, PageLoad, useLoad } from "../load";
import { PLUGIN_WEB } from "../plugins";
import { navigate } from "../router";
import {
  forgetPluginData,
  installPlugin,
  loadPlugins,
  pluginAction,
  pluginRunning,
  savePlugin,
  savePluginSecrets,
  uninstallPlugin,
  useStore,
} from "../store";
import { Switch } from "../switch";
import { BackHead, Disclosure, Group, LinkRow, Select } from "../ui";
import { saveSafety, TOOL_LEVELS } from "./Safety";

const STATE: Record<PluginInfo["state"], string> = {
  off: "Off",
  starting: "Starting",
  ready: "On",
  needs_setup: "Needs setup",
  error: "Error",
};

export function PluginsPage() {
  const { data: ids, error, retry } = useLoad(() => loadPlugins(), []);
  const plugins = useStore((s) => s.plugins);
  return (
    <section className="view">
      <div className="page narrow">
        <BackHead to="/settings" label="Settings">
          <Link className="btn" to="/settings/add-plugin">
            <Icon name="plus" />
            Add
          </Link>
        </BackHead>
        {error && <LoadError error={error} retry={retry} />}
        {!!ids?.length && (
          <Group>
            {ids.map((id) => {
              const p = plugins[id];
              if (!p) return null;
              return (
                <LinkRow key={id} to={`/settings/plugins/${id}`} label={p.name}>
                  <span className="val">{STATE[p.state]}</span>
                </LinkRow>
              );
            })}
          </Group>
        )}
      </div>
    </section>
  );
}

export function PluginPage({ id, toast }: { id: string; toast: (t: string) => void }) {
  const p = useStore((s) => s.plugins[id]);
  const { error, run } = useAction();
  const testing = useAction();
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  /** The switch as you just set it, until the brain answers. */
  const [turning, setTurning] = useState<boolean | null>(null);
  const action = useMemo(() => pluginAction(id), [id]);
  // Again when it's not known: deleted, or not loaded yet.
  const load = useLoad(() => (p ? Promise.resolve(false) : loadPlugins().then(() => true)), [!p]);

  if (!p)
    return (
      <PageLoad
        error={load.error}
        missing={load.data ? "This plugin doesn't exist." : ""}
        retry={load.retry}
        back={{ label: "Plugins", to: "/settings/plugins" }}
      />
    );

  const Settings = PLUGIN_WEB[p.id]?.settings;
  const toggle = async (enabled: boolean) => {
    setResult(null);
    // It flips at once; a failed save flips it back.
    setTurning(enabled);
    await run(() => savePlugin(p.id, { enabled }));
    setTurning(null);
  };
  const save = async (config: unknown, turnOn = false) => {
    await savePlugin(p.id, turnOn ? { config, enabled: true } : { config });
    if (!turnOn) toast("Saved");
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
        <BackHead to="/settings/plugins" label="Plugins">
          {p.testable && p.state === "ready" && (
            <button type="button" className="btn sm" disabled={testing.busy} onClick={test}>
              <Icon name="play" />
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
            running={pluginRunning(p)}
          />
        )}

        {p.tools.length > 0 && <ToolList tools={p.tools} />}

        <PluginData p={p} toast={toast} />
      </div>
    </section>
  );
}

/** Where it came from, and removing it or what it kept. */
function PluginData({ p, toast }: { p: PluginInfo; toast: (t: string) => void }) {
  const { busy, error, run } = useAction();
  const uninstall = async (data: boolean) => {
    const text = data
      ? `Uninstall ${p.name} and delete its settings, secrets and data?`
      : `Uninstall ${p.name}? Its settings and data stay, for if you install it again.`;
    if (!(await ask({ text, ok: "Uninstall" }))) return;
    run(async () => {
      await uninstallPlugin(p.id, data);
      toast("Uninstalled. Hatbot is restarting.");
      navigate("/settings/plugins");
    });
  };
  const forget = async () => {
    // What a built-in plugin keeps in Hatbot's own tables stays.
    if (await ask({ text: `Delete ${p.name}'s settings and secrets?`, ok: "Delete" }))
      run(async () => {
        await forgetPluginData(p.id);
        toast("Deleted");
      });
  };
  if (!p.source && p.enabled) return null;
  return (
    <div className="panel form">
      {p.source && (
        <>
          <span className="label">Installed from</span>
          <div className="mono">{p.source.url}</div>
          <div className="mono">{p.source.commit}</div>
        </>
      )}
      {error && <div className="form-error">{error}</div>}
      <div className="form-actions">
        {p.source ? (
          <>
            <button
              type="button"
              className="btn danger-text"
              disabled={busy}
              onClick={() => uninstall(true)}
            >
              Uninstall and delete its data
            </button>
            <button type="button" className="btn" disabled={busy} onClick={() => uninstall(false)}>
              Uninstall
            </button>
          </>
        ) : (
          <button type="button" className="btn danger-text" disabled={busy} onClick={forget}>
            Delete its settings
          </button>
        )}
      </div>
    </div>
  );
}

/** From plugins.json, or any git repository at a commit. */
export function AddPluginPage({ toast }: { toast: (t: string) => void }) {
  const {
    data: index,
    error: loadError,
    retry,
  } = useLoad(() => api<PluginIndexEntry[]>("/plugins/index"), []);
  const [url, setUrl] = useState("");
  const [commit, setCommit] = useState("");
  const { busy, error, run } = useAction();
  useLeaveGuard(!busy && (!!url.trim() || !!commit.trim()));

  const install = async (name: string, from: string, at: string) => {
    if (
      !(await ask({
        text: `Install ${name}? It runs inside Hatbot and can reach everything Hatbot can: your chats, memory, secrets and accounts.`,
        ok: "Install",
      }))
    )
      return;
    run(async () => {
      await installPlugin(from.trim(), at.trim());
      toast("Installed. Hatbot is restarting to load it.");
      navigate("/settings/plugins");
    });
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void install("this plugin", url, commit);
  };
  const offered = index?.filter((p) => !p.installed) ?? [];

  return (
    <section className="view">
      <div className="page narrow">
        <BackHead to="/settings/plugins" label="Plugins" />
        {loadError && <LoadError error={loadError} retry={retry} />}
        {offered.length > 0 && (
          <Group>
            {offered.map((p) => (
              <div className="row" key={p.id}>
                <div className="txt" title={p.description}>
                  <b>{p.name}</b>
                </div>
                <button
                  type="button"
                  className="btn sm"
                  disabled={busy}
                  onClick={() => install(p.name, p.url, p.commit)}
                >
                  Install
                </button>
              </div>
            ))}
          </Group>
        )}
        <form className="panel form" onSubmit={submit}>
          <h3 className="section-title">From a git repository</h3>
          <div>
            A plugin runs inside Hatbot with everything Hatbot has. Install only ones whose code you
            trust.
          </div>
          <label>
            <span className="label">Repository</span>
            <input
              className="field mono"
              autoComplete="off"
              spellCheck={false}
              placeholder="https://github.com/someone/hatbot-plugin.git"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
          </label>
          <label>
            <span className="label">Commit</span>
            <input
              className="field mono"
              autoComplete="off"
              spellCheck={false}
              placeholder="The whole 40-character hash"
              value={commit}
              onChange={(e) => setCommit(e.target.value)}
            />
          </label>
          {error && <div className="form-error">{error}</div>}
          <div className="form-actions">
            <button
              type="submit"
              className="btn accent"
              disabled={busy || !url.trim() || !commit.trim()}
            >
              {busy ? "Installing…" : "Install"}
            </button>
          </div>
        </form>
      </div>
    </section>
  );
}

/** Each change can always ask or never ask, past what the plugin says (Settings → Safety). */
function ToolList({ tools }: { tools: PluginInfo["tools"] }) {
  const settingsVersion = useStore((s) => s.settingsVersion);
  const { data: settings, setData } = useLoad(
    () => api<AppSettings>("/settings"),
    [settingsVersion],
  );
  const [error, setError] = useState("");
  const set = async (name: string, level: (typeof TOOL_LEVELS)[number][0]) => {
    if (!settings) return;
    const { [name]: _, ...rest } = settings.safety.tools;
    setError("");
    try {
      setData(await saveSafety({ tools: level === "plugin" ? rest : { ...rest, [name]: level } }));
    } catch (err) {
      setError(errorText(err));
    }
  };
  return (
    <Disclosure label={tools.length === 1 ? "1 tool" : `${tools.length} tools`}>
      {error && <div className="form-error">{error}</div>}
      <div className="group-box">
        {tools.map((t) => (
          <div className="row" key={t.name}>
            <div className="txt">
              <b className="mono">{t.name}</b>
            </div>
            {t.access === "write" && settings ? (
              <Select
                label={`When ${t.name} asks`}
                value={settings.safety.tools[t.name] ?? "plugin"}
                options={TOOL_LEVELS}
                onChange={(level) => set(t.name, level)}
              />
            ) : (
              <span className="val">{t.access === "read" ? "Reads" : "Changes"}</span>
            )}
          </div>
        ))}
      </div>
    </Disclosure>
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
  useLeaveGuard(Object.keys(changes).length > 0);

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
      <Disclosure label="Environment" open={!p.env.every((v) => v.from === "host")}>
        {p.env.map((v) => (
          <div key={v.name}>
            <span className="label">
              <span className="mono">{v.name}</span>
              {v.optional ? " (optional)" : !v.from && " (missing)"}
            </span>
            <div className="form-row">
              <input
                className="field mono"
                aria-label={v.name}
                type={v.secret ? "password" : "text"}
                autoComplete="off"
                spellCheck={false}
                placeholder={v.secret && v.from ? SOURCE[v.from] : (v.hint ?? "")}
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
      </Disclosure>
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
  useLeaveGuard(!!name.trim() || !!value);
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
          <button
            type="button"
            className="btn sm danger-text"
            disabled={busy}
            onClick={() => remove(n)}
          >
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
