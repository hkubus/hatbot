// RCON's password goes in Settings → Secrets, never in the settings: the server keeps only its name.
import {
  Disclosure,
  Panel,
  type PluginSettingsProps,
  type PluginWeb,
  SaveBar,
  useAction,
  useLeaveGuard,
} from "@hatbot/web/kit";
import { useEffect, useState } from "react";

type Server = { name: string; host: string; port: number; rconPort: number; rconSecret: string };
type Config = { servers: Server[] };
/** `key` stays with its row when others are removed; `password` is typed in, not saved here. */
type Row = Server & { key: number; password: string };

const NAME = /^[a-z0-9][a-z0-9-]{0,30}$/;
const SECRET = /^[A-Z][A-Z0-9_]{0,63}$/;
const secretFor = (name: string) => `MINECRAFT_${name.replace(/-/g, "_").toUpperCase()}_RCON`;

let nextKey = 0;
const toRow = (s: Server): Row => ({ ...s, key: nextKey++, password: "" });
const blank = (): Row =>
  toRow({ name: "", host: "", port: 25565, rconPort: 25575, rconSecret: "" });
const serverOf = ({ key: _, password, ...s }: Row): Server => {
  const name = s.name.trim();
  const secret = s.rconSecret.trim();
  return {
    ...s,
    name,
    host: s.host.trim(),
    rconSecret: password && !secret ? secretFor(name) : secret,
  };
};

export function MinecraftSettings({ config, save, action, running }: PluginSettingsProps<Config>) {
  const [rows, setRows] = useState<Row[]>(() => config.servers.map(toRow));
  const [kept, setKept] = useState<string[]>([]);
  const { busy, error, run } = useAction();

  useEffect(() => {
    if (!running) return;
    action<string[]>("kept").then(setKept, () => {});
  }, [action, running]);

  const set = (i: number, patch: Partial<Row>) =>
    setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const servers = rows.map(serverOf);
  const changed =
    JSON.stringify(servers) !== JSON.stringify(config.servers) || rows.some((r) => r.password);
  useLeaveGuard(changed);
  const names = servers.map((s) => s.name);
  const problem = servers.some((s) => s.name && !NAME.test(s.name))
    ? "Names are lowercase letters, digits and -, like survival."
    : servers.some((s) => s.rconSecret && !SECRET.test(s.rconSecret))
      ? "A secret's name is capitals, digits and _, like MINECRAFT_RCON."
      : new Set(names).size < names.length
        ? "Two servers have one name."
        : "";
  const complete = servers.every((s) => s.name && s.host);

  const submit = () =>
    run(async () => {
      const typed = rows.flatMap((r, i) =>
        r.password ? [{ name: servers[i]?.rconSecret ?? "", value: r.password }] : [],
      );
      // Its actions answer only while it's on.
      await save({ servers }, typed.length > 0 && !running);
      for (const t of typed) await action("keep", t);
      setRows((now) => now.map((r) => ({ ...r, password: "" })));
      setKept(await action<string[]>("kept"));
    });

  return (
    <Panel title="Servers" className="form">
      {rows.map((r, i) => {
        const secret = servers[i]?.rconSecret ?? "";
        return (
          <div className="host-edit" key={r.key}>
            <div className="host-fields">
              <input
                className="field"
                aria-label="Name"
                placeholder="Name, e.g. survival"
                value={r.name}
                onChange={(e) => set(i, { name: e.target.value.toLowerCase() })}
              />
              <input
                className="field"
                aria-label="Address"
                placeholder="Address"
                value={r.host}
                onChange={(e) => set(i, { host: e.target.value })}
              />
              <input
                className="field"
                aria-label="Port"
                title="Port"
                type="number"
                min={1}
                max={65535}
                value={r.port}
                onChange={(e) => set(i, { port: Number(e.target.value) || 25565 })}
              />
              <input
                className="field"
                aria-label="RCON port"
                title="RCON port"
                type="number"
                min={1}
                max={65535}
                value={r.rconPort}
                onChange={(e) => set(i, { rconPort: Number(e.target.value) || 25575 })}
              />
            </div>
            <label>
              <span className="label">RCON password, for commands</span>
              <input
                className="field"
                type="password"
                autoComplete="new-password"
                placeholder={
                  secret && kept.includes(secret) ? "Kept; type a new one to replace it" : "Not set"
                }
                value={r.password}
                onChange={(e) => set(i, { password: e.target.value })}
              />
            </label>
            <Disclosure label="More">
              <label>
                <span className="label">Kept in Settings → Secrets as</span>
                <input
                  className="field mono"
                  placeholder={r.name ? secretFor(r.name) : "MINECRAFT_RCON"}
                  value={r.rconSecret}
                  onChange={(e) => set(i, { rconSecret: e.target.value.toUpperCase() })}
                />
              </label>
            </Disclosure>
            <div className="form-actions">
              <button
                type="button"
                className="btn sm danger-text"
                onClick={() => setRows(rows.filter((_, j) => j !== i))}
              >
                Remove
              </button>
            </div>
          </div>
        );
      })}
      {problem && <div className="form-error">{problem}</div>}
      <SaveBar error={error} disabled={busy || !changed || !complete || !!problem} onSave={submit}>
        <button type="button" className="btn sm" onClick={() => setRows([...rows, blank()])}>
          Add server
        </button>
      </SaveBar>
    </Panel>
  );
}

export const web: PluginWeb = { settings: MinecraftSettings };
