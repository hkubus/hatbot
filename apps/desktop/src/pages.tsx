import { Copyable, Group, Icon, OtpInput, Row, Switch } from "@hatbot/web/kit";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { type AppState, act, useAppState } from "./state";

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="login">
      <div className="login-card">
        <div className="brand-mark">
          <Icon name="hat" />
        </div>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

const Failure = ({ text }: { text: string | null }) =>
  text ? <div className="form-error">{text}</div> : null;

export function Main() {
  const s = useAppState();
  if (!s || s.phase === "starting") return null;
  if (s.phase === "login") return <SignIn s={s} />;
  if (s.phase === "settingUp")
    return (
      <Card title="Setting up Hatbot">
        <div className="muted hint">{s.step}…</div>
      </Card>
    );
  if (s.phase === "in")
    return (
      <Card title="Hatbot">
        <button type="button" className="btn accent" onClick={() => act({ do: "openHatbot" })}>
          Open Hatbot
        </button>
      </Card>
    );
  return (
    <Card title="Welcome to Hatbot">
      <div className="muted hint">
        Hatbot can run on this computer, or you can connect to one on a server. Running it here
        downloads Hatbot and starts it whenever you log in. That takes a few minutes the first time.
      </div>
      <Failure text={s.error} />
      <button type="button" className="btn accent" onClick={() => act({ do: "runHere" })}>
        Run it here
      </button>
      <button type="button" className="btn" onClick={() => act({ do: "connectElsewhere" })}>
        Connect to a server
      </button>
    </Card>
  );
}

function SignIn({ s }: { s: AppState }) {
  const [address, setAddress] = useState(s.server ?? "");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  useEffect(() => {
    if (s.error) setCode("");
  }, [s.error]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    act({ do: "signIn", address: address.trim(), password, code });
  };
  return (
    <div className="login">
      <form className="login-card" onSubmit={submit}>
        <div className="brand-mark">
          <Icon name="hat" />
        </div>
        <h2>Sign in to Hatbot</h2>
        <input
          className="field"
          placeholder="Address"
          aria-label="Address"
          inputMode="url"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
        />
        <input
          className="field"
          type="password"
          placeholder="Password"
          aria-label="Password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <div className="muted hint">Code from your authenticator</div>
        <OtpInput value={code} onChange={setCode} />
        <Failure text={s.error} />
        <button
          className="btn accent"
          type="submit"
          disabled={s.busy || !address.trim() || !password || code.length !== 6}
        >
          {s.busy ? "Signing in" : "Sign in"}
        </button>
        <button type="button" className="btn ghost" onClick={() => act({ do: "back" })}>
          Back
        </button>
      </form>
    </div>
  );
}

export function Computer() {
  const s = useAppState();
  if (!s) return null;
  if (s.phase !== "in")
    return (
      <Card title="This computer">
        <div className="muted hint">Sign in to Hatbot first.</div>
        <button type="button" className="btn accent" onClick={() => act({ do: "openHatbot" })}>
          Open Hatbot
        </button>
      </Card>
    );
  const st = s.agent.status;
  return (
    <div className="scroll">
      <div className="page narrow">
        <Group>
          <Row label="Let Hatbot use this computer">
            <Switch on={s.computerEnabled} onChange={(on) => act({ do: "computerEnabled", on })} />
          </Row>
        </Group>
        {s.computerEnabled && (
          <Group title="Status">
            <Row label="Connection">
              <span className="muted">
                {s.agent.online ? "Connected to Hatbot" : "Not connected to Hatbot"}
              </span>
            </Row>
            <Row label="This computer">
              <span className="muted">
                {st.locked ? "Locked" : st.ownerActive ? "You're using it" : "Idle"}
              </span>
            </Row>
            {st.screen && (
              <Row label="Hatbot is using it">
                <button
                  type="button"
                  className="btn sm danger"
                  onClick={() => act({ do: "stopComputer" })}
                >
                  Stop
                </button>
              </Row>
            )}
            <Row label="Paused">
              <Switch on={st.paused} onChange={(on) => act({ do: "computerPaused", on })} />
            </Row>
          </Group>
        )}
        {s.local && (
          <Group title="Other devices">
            <Row label="Reach it from other devices">
              <Switch on={!!s.lan} onChange={(on) => act({ do: "lan", on })} />
            </Row>
            {s.lan && (
              <Row label="Address">
                <Copyable value={s.lan} />
              </Row>
            )}
          </Group>
        )}
        <Failure text={s.error} />
      </div>
    </div>
  );
}

export function Banner() {
  const [stopping, setStopping] = useState(false);
  return (
    <div className="banner">
      <span>Hatbot is using this computer</span>
      <button
        type="button"
        className="btn sm danger"
        disabled={stopping}
        onClick={() => {
          setStopping(true);
          act({ do: "stopComputer" });
        }}
      >
        {stopping ? "Stopping" : "Stop"}
      </button>
    </div>
  );
}
