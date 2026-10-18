// SSH's settings: the brain's public key to install, the hosts Hatbot may reach, and their pinned keys.
import { useEffect, useState } from "react";
import { useAction } from "../action";
import { errorText } from "../api";
import { ask, useLeaveGuard } from "../confirm";
import { Icon } from "../icons";
import { Switch } from "../switch";
import type { PluginSettingsProps } from ".";

type Host = {
  name: string;
  address: string;
  user: string;
  port: number;
  careful: boolean;
  /** infra/pct-exec-setup.sh ran on it: Hatbot can run commands in its containers. */
  proxmox: boolean;
};
type Config = { hosts: Host[] };

const blank = (): Host => ({
  name: "",
  address: "",
  user: "hatbot",
  port: 22,
  careful: false,
  proxmox: false,
});

export function SshSettings({ config, save, action, running }: PluginSettingsProps<Config>) {
  const [hosts, setHosts] = useState<Host[]>(config.hosts);
  const [publicKey, setPublicKey] = useState("");
  const [keys, setKeys] = useState<Record<string, string | null>>({});
  const { busy, error, setError, run } = useAction();

  useEffect(() => {
    if (!running) return;
    action<string>("publicKey").then(setPublicKey, (err) => setError(errorText(err)));
    action<{ name: string; key: string | null }[]>("keys").then(
      (list) => setKeys(Object.fromEntries(list.map((k) => [k.name, k.key]))),
      () => {},
    );
  }, [action, running, setError]);

  const set = (i: number, patch: Partial<Host>) =>
    setHosts(hosts.map((h, j) => (j === i ? { ...h, ...patch } : h)));
  const changed = JSON.stringify(hosts) !== JSON.stringify(config.hosts);
  useLeaveGuard(changed);
  const complete = hosts.every((h) => h.name.trim() && h.address.trim() && h.user.trim());

  const submit = () =>
    run(() =>
      save({
        hosts: hosts.map((h) => ({ ...h, name: h.name.trim(), address: h.address.trim() })),
      }),
    );
  const forget = async (name: string) => {
    if (
      !(await ask({
        text: `Forget ${name}'s host key? Hatbot trusts whatever key it sees next.`,
        ok: "Forget",
      }))
    )
      return;
    await run(async () => {
      await action("forget", { name });
      setKeys({ ...keys, [name]: null });
    });
  };

  return (
    <>
      {publicKey && (
        <div className="panel form">
          <span className="label">Add to ~hatbot/.ssh/authorized_keys on each host</span>
          <div className="copyable">
            <code>{publicKey}</code>
            <button
              type="button"
              className="btn sm ghost"
              title="Copy"
              onClick={() => navigator.clipboard?.writeText(publicKey)}
            >
              <Icon name="copy" />
            </button>
          </div>
        </div>
      )}

      <div className="panel form">
        {hosts.map((h, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: rows are edited in place
          <div className="host-edit" key={i}>
            <div className="host-fields">
              <input
                className="field"
                aria-label="Name"
                placeholder="Name, e.g. nas"
                value={h.name}
                onChange={(e) => set(i, { name: e.target.value.toLowerCase() })}
              />
              <input
                className="field"
                aria-label="Address"
                placeholder="Address"
                value={h.address}
                onChange={(e) => set(i, { address: e.target.value })}
              />
              <input
                className="field"
                aria-label="User"
                placeholder="User"
                value={h.user}
                onChange={(e) => set(i, { user: e.target.value })}
              />
              <input
                className="field"
                aria-label="Port"
                type="number"
                min={1}
                max={65535}
                value={h.port}
                onChange={(e) => set(i, { port: Number(e.target.value) || 22 })}
              />
            </div>
            <div className="form-row">
              <span className="label">Ask before every change</span>
              <Switch on={h.careful} onChange={(careful) => set(i, { careful })} />
            </div>
            <div className="form-row">
              <span className="label">Proxmox host: run commands in its containers</span>
              <Switch on={h.proxmox} onChange={(proxmox) => set(i, { proxmox })} />
            </div>
            <div className="form-row">
              <span className="label mono">{keys[h.name] ?? "No key pinned yet"}</span>
              <span className="host-actions">
                {keys[h.name] && (
                  <button type="button" className="btn sm" onClick={() => forget(h.name)}>
                    Forget key
                  </button>
                )}
                <button
                  type="button"
                  className="btn sm danger-text"
                  onClick={() => setHosts(hosts.filter((_, j) => j !== i))}
                >
                  Remove
                </button>
              </span>
            </div>
          </div>
        ))}
        {error && <div className="form-error">{error}</div>}
        <div className="form-row">
          <button type="button" className="btn sm" onClick={() => setHosts([...hosts, blank()])}>
            Add host
          </button>
          <button
            type="button"
            className="btn accent"
            disabled={busy || !changed || !complete}
            onClick={submit}
          >
            Save
          </button>
        </div>
      </div>
    </>
  );
}
