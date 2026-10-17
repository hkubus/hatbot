// MCP's settings: servers, and for each of their tools whether Hatbot may use it.
import { useEffect, useState } from "react";
import { ApiError } from "../api";
import { useLeaveGuard } from "../confirm";
import { Switch } from "../switch";
import type { PluginSettingsProps } from ".";

type Mode = "chat" | "allow" | "ask" | "always" | "off";
/** What a tool's calls are: money and accounts always ask, and never in the chat. */
type Kind = "payment" | "purchase" | "account_security" | "none";
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
  /** Per tool, the hash of the definition the owner accepted. */
  accepted: Record<string, string>;
  /** Per tool, the hash of the definition its Chat or Allow mode was chosen for. */
  pinned: Record<string, string>;
  /** Per tool, what its calls are, when the owner set it. */
  kinds: Record<string, Kind>;
};
type Config = { servers: Server[] };
type Status = {
  name: string;
  state: "connected" | "failed" | "off";
  error: string | null;
  /**
   * What the model reads of each tool (description, schema), and its hash. problem: why it can't be
   * offered, e.g. a schema Claude's API wouldn't take.
   */
  tools: {
    name: string;
    description: string;
    schema: string;
    mode: Mode;
    problem: string | null;
    hash: string;
    /** What its name and description suggest it does, if it moves money. */
    guess: "payment" | "purchase" | null;
  }[];
};
type Tool = Status["tools"][number];

const MODES: [Mode, string][] = [
  ["off", "Off"],
  ["ask", "Ask first"],
  ["always", "Always ask"],
  ["allow", "Allow"],
  ["chat", "Chat, no asking"],
];
const KINDS: [Kind, string][] = [
  ["none", "Other changes"],
  ["payment", "Pays or moves money"],
  ["purchase", "Buys or orders"],
  ["account_security", "Changes accounts or keys"],
];

/** What a tool's calls are, as the form has it: the owner's say, or the brain's guess. */
export const kindIn = (s: Server, t: Tool): Kind => s.kinds[t.name] ?? t.guess ?? "none";
/** A Chat or Allow mode chosen for another definition of the tool than the one there now. */
export const lapsedIn = (s: Server, t: Tool) => {
  const set = s.tools[t.name];
  return (set === "chat" || set === "allow") && (s.pinned[t.name] ?? s.accepted[t.name]) !== t.hash;
};
/** The mode the brain would use with the form's settings, as the brain works it out. */
export function modeIn(s: Server, t: Tool): Mode {
  const money = kindIn(s, t) !== "none";
  const mode = (lapsedIn(s, t) ? undefined : s.tools[t.name]) ?? (money ? "always" : "ask");
  if (money && mode === "ask") return "always";
  if (money && mode === "chat") return "allow";
  return mode;
}
/** Choosing a mode: Chat and Allow are kept for the definition as it is now. */
export function withMode(s: Server, t: Tool, mode: Mode): Partial<Server> {
  const { [t.name]: _, ...pinned } = s.pinned;
  return {
    tools: { ...s.tools, [t.name]: mode },
    pinned: mode === "chat" || mode === "allow" ? { ...pinned, [t.name]: t.hash } : pinned,
  };
}
/** Choosing a kind: the guess needs no entry. */
export function withKind(s: Server, t: Tool, kind: Kind): Partial<Server> {
  const { [t.name]: _, ...kinds } = s.kinds;
  return { kinds: kind === (t.guess ?? "none") ? kinds : { ...kinds, [t.name]: kind } };
}
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
  accepted: {},
  pinned: {},
  kinds: {},
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
        // Offered tools of an untrusted server whose definitions the owner hasn't accepted as they are.
        const pending =
          st && !s.trusted
            ? st.tools.filter(
                (t) => !t.problem && modeIn(s, t) !== "off" && s.accepted[t.name] !== t.hash,
              )
            : [];
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
                <div className="hint">
                  A command runs on the brain as Hatbot's own user, so it can read every secret
                  Hatbot has: its keys, tokens and database. Run only servers you trust, or an HTTP
                  server elsewhere. Pin the version (package@1.2.3): npx and uvx fetch the newest
                  one at every start.
                </div>
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
                    placeholder={"-y\n@scope/server@1.2.3"}
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
            {pending.length > 0 && (
              <div className="form-row">
                <span className="hint">
                  {pending.length === 1 ? "A tool's description isn't" : "Tool descriptions aren't"}{" "}
                  accepted yet, or changed since. Until you read and accept them, every chat and
                  task they're offered in counts as having read untrusted content.
                </span>
                <button
                  type="button"
                  className="btn sm"
                  onClick={() =>
                    set(i, {
                      accepted: {
                        ...s.accepted,
                        ...Object.fromEntries(pending.map((t) => [t.name, t.hash])),
                      },
                    })
                  }
                >
                  Accept
                </button>
              </div>
            )}
            {st && st.tools.length > 0 && (
              <div className="group-box">
                {st.tools.map((t) => (
                  <div className="row" key={t.name}>
                    <div className="txt">
                      <b className="mono">{t.name}</b>
                      {t.problem && <span>{t.problem}</span>}
                      {lapsedIn(s, t) && (
                        <span>
                          It changed since you chose{" "}
                          {s.tools[t.name] === "chat" ? "Chat, no asking" : "Allow"}, so it asks
                          until you choose again.
                        </span>
                      )}
                      {t.description && <span>{t.description}</span>}
                      <details>
                        <summary className="hint">Inputs</summary>
                        <pre className="mono hint" style={{ whiteSpace: "pre-wrap", margin: 0 }}>
                          {t.schema}
                        </pre>
                      </details>
                    </div>
                    <select
                      aria-label="What it does"
                      value={kindIn(s, t)}
                      onChange={(e) => set(i, withKind(s, t, e.target.value as Kind))}
                    >
                      {KINDS.map(([k, label]) => (
                        <option key={k} value={k}>
                          {label}
                        </option>
                      ))}
                    </select>
                    <select
                      aria-label="When it asks"
                      value={modeIn(s, t)}
                      onChange={(e) => set(i, withMode(s, t, e.target.value as Mode))}
                    >
                      {MODES.filter(
                        ([m]) => kindIn(s, t) === "none" || (m !== "ask" && m !== "chat"),
                      ).map(([m, label]) => (
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
