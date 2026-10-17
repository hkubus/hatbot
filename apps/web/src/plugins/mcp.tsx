// MCP's settings: servers, and for each of their tools whether Hatbot may use it.
import { useEffect, useState } from "react";
import { ApiError } from "../api";
import { useLeaveGuard } from "../confirm";
import { Switch } from "../switch";
import type { PluginSettingsProps } from ".";

type Mode = "chat" | "allow" | "ask" | "off";
type Server = {
  name: string;
  transport: "http" | "stdio";
  url?: string;
  headers: Record<string, string>;
  command?: string;
  args: string[];
  env: Record<string, string>;
  trusted: boolean;
  enabled: boolean;
  tools: Record<string, Mode>;
};
type Config = { servers: Server[] };
type Status = {
  name: string;
  state: "connected" | "failed" | "off";
  error: string | null;
  tools: { name: string; description: string; mode: Mode }[];
};

const MODES: [Mode, string][] = [
  ["ask", "Ask first"],
  ["allow", "Allow"],
  ["chat", "Read-only"],
  ["off", "Off"],
];
const blank = (): Server => ({
  name: "",
  transport: "http",
  url: "",
  headers: {},
  args: [],
  env: {},
  trusted: false,
  enabled: true,
  tools: {},
});
const errorText = (err: unknown) =>
  err instanceof ApiError ? err.message : "Couldn't reach Hatbot.";
const toLines = (r: Record<string, string>) =>
  Object.entries(r)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
const fromLines = (s: string) =>
  Object.fromEntries(
    s
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.includes("="))
      .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
  );

/** A server as edited: its list fields as text, and a key that stays with it when others are removed. */
type Row = Server & { key: number; headersText: string; argsText: string; envText: string };
let nextKey = 0;
const toRow = (s: Server): Row => ({
  ...s,
  key: nextKey++,
  headersText: toLines(s.headers),
  argsText: s.args.join("\n"),
  envText: toLines(s.env),
});
const fromRow = ({ key: _, headersText, argsText, envText, ...s }: Row): Server =>
  s.transport === "http"
    ? { ...s, headers: fromLines(headersText), command: undefined, args: [], env: {} }
    : {
        ...s,
        url: undefined,
        headers: {},
        args: argsText.split("\n").filter((a) => a.trim()),
        env: fromLines(envText),
      };

export function McpSettings({ config, save, action, running }: PluginSettingsProps<Config>) {
  const [servers, setServers] = useState<Row[]>(() => config.servers.map(toRow));
  const [status, setStatus] = useState<Record<string, Status>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!running) return;
    action<Status[]>("status").then(
      (list) => setStatus(Object.fromEntries(list.map((s) => [s.name, s]))),
      () => {},
    );
  }, [action, running]);

  const set = (i: number, patch: Partial<Row>) =>
    setServers(servers.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const changed =
    JSON.stringify(servers.map(fromRow)) !==
    JSON.stringify(config.servers.map((s) => fromRow(toRow(s))));
  useLeaveGuard(changed);

  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      await save({ servers: servers.map(fromRow) });
    } catch (err) {
      setError(errorText(err));
    }
    setBusy(false);
  };

  return (
    <>
      {servers.map((s, i) => {
        const st = status[s.name];
        return (
          <div className="panel form" key={s.key}>
            <div className="form-row">
              <input
                className="field"
                placeholder="Name, e.g. github"
                value={s.name}
                onChange={(e) => set(i, { name: e.target.value.toLowerCase() })}
              />
              <div className="seg">
                {(["http", "stdio"] as const).map((t) => (
                  <button
                    type="button"
                    key={t}
                    className={s.transport === t ? "active" : ""}
                    aria-pressed={s.transport === t}
                    onClick={() => set(i, { transport: t })}
                  >
                    {t === "http" ? "HTTP" : "Command"}
                  </button>
                ))}
              </div>
            </div>
            {st?.state === "failed" && <div className="form-error">{st.error}</div>}
            {s.transport === "http" ? (
              <>
                <label>
                  <span className="label">URL</span>
                  <input
                    className="field mono"
                    value={s.url ?? ""}
                    placeholder="https://mcp.example.com/mcp"
                    onChange={(e) => set(i, { url: e.target.value })}
                  />
                </label>
                <label>
                  <span className="label">
                    Headers, one NAME=value per line; ${"{SECRET}"} reads mcp.env
                  </span>
                  <textarea
                    className="field mono"
                    rows={2}
                    value={s.headersText}
                    onChange={(e) => set(i, { headersText: e.target.value })}
                  />
                </label>
              </>
            ) : (
              <>
                <label>
                  <span className="label">Command (runs on the brain)</span>
                  <input
                    className="field mono"
                    value={s.command ?? ""}
                    placeholder="npx"
                    onChange={(e) => set(i, { command: e.target.value })}
                  />
                </label>
                <label>
                  <span className="label">Arguments, one per line</span>
                  <textarea
                    className="field mono"
                    rows={2}
                    value={s.argsText}
                    onChange={(e) => set(i, { argsText: e.target.value })}
                  />
                </label>
                <label>
                  <span className="label">
                    Environment, one NAME=value per line; ${"{SECRET}"} reads mcp.env
                  </span>
                  <textarea
                    className="field mono"
                    rows={2}
                    value={s.envText}
                    onChange={(e) => set(i, { envText: e.target.value })}
                  />
                </label>
              </>
            )}
            <div className="form-row">
              <span className="label">Trust its output and tool descriptions</span>
              <Switch on={s.trusted} onChange={(trusted) => set(i, { trusted })} />
            </div>
            <div className="form-row">
              <span className="label">On</span>
              <Switch on={s.enabled} onChange={(enabled) => set(i, { enabled })} />
            </div>
            {st && st.tools.length > 0 && (
              <div className="group-box">
                {st.tools.map((t) => (
                  <div className="row" key={t.name}>
                    <div className="txt">
                      <b className="mono">{t.name}</b>
                    </div>
                    <select
                      value={s.tools[t.name] ?? "ask"}
                      onChange={(e) =>
                        set(i, { tools: { ...s.tools, [t.name]: e.target.value as Mode } })
                      }
                    >
                      {MODES.map(([m, label]) => (
                        <option key={m} value={m}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
            )}
            <div className="form-actions">
              <button
                type="button"
                className="btn sm danger-text"
                onClick={() => setServers(servers.filter((_, j) => j !== i))}
              >
                Remove
              </button>
            </div>
          </div>
        );
      })}
      {error && <div className="form-error">{error}</div>}
      <div className="form-row">
        <button
          type="button"
          className="btn sm"
          onClick={() => setServers([...servers, toRow(blank())])}
        >
          Add server
        </button>
        <button type="button" className="btn accent" disabled={busy || !changed} onClick={submit}>
          Save
        </button>
      </div>
    </>
  );
}
