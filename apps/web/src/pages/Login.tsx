import type { SetupStartResponse } from "@hatbot/shared";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { ApiError, api } from "../api";
import { Icon } from "../icons";

function OtpInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  const digits = Array.from({ length: 6 }, (_, i) => value[i] ?? "");
  const setAt = (i: number, d: string) => {
    const next = digits.slice();
    next[i] = d;
    onChange(next.join("").slice(0, 6));
  };
  return (
    <div className="otp">
      {digits.map((d, i) => (
        <input
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed six positions
          key={i}
          ref={(el) => {
            refs.current[i] = el;
          }}
          inputMode="numeric"
          autoComplete={i === 0 ? "one-time-code" : "off"}
          aria-label={`Digit ${i + 1}`}
          value={d}
          onChange={(e) => {
            const v = e.target.value.replace(/\D/g, "");
            if (v.length > 1) {
              // Pasted or autofilled code.
              onChange(v.slice(0, 6));
              refs.current[Math.min(5, v.length)]?.focus();
              return;
            }
            setAt(i, v);
            if (v) refs.current[i + 1]?.focus();
          }}
          onKeyDown={(e) => {
            if (e.key === "Backspace" && !d) refs.current[i - 1]?.focus();
          }}
        />
      ))}
    </div>
  );
}

const message = (err: unknown) => (err instanceof ApiError ? err.message : "Couldn't reach Hatbot");

export function Login({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/auth/login", { body: { password, totp } });
      onDone();
    } catch (err) {
      setError(message(err));
      setTotp("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <form className="login-card" onSubmit={submit}>
        <div className="brand-mark">
          <Icon name="hat" />
        </div>
        <h2>Hatbot</h2>
        <input
          className="field"
          type="password"
          placeholder="Password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <div className="muted" style={{ fontSize: 12 }}>
          Code from your authenticator
        </div>
        <OtpInput value={totp} onChange={setTotp} />
        {error && <div className="form-error">{error}</div>}
        <button
          className="btn accent"
          type="submit"
          disabled={busy || !password || totp.length !== 6}
        >
          Sign in
        </button>
      </form>
    </div>
  );
}

export function Setup({ onDone }: { onDone: () => void }) {
  const [code, setCode] = useState("");
  const [secret, setSecret] = useState<SetupStartResponse | null>(null);
  const [qr, setQr] = useState("");
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const [totp, setTotp] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!secret) return;
    // Loaded only here: setup happens once.
    import("qrcode").then((QRCode) =>
      QRCode.toString(secret.uri, { type: "svg", margin: 0 }).then(setQr),
    );
  }, [secret]);

  const start = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    try {
      setSecret(
        await api<SetupStartResponse>("/auth/setup/start", { body: { code: code.trim() } }),
      );
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 403
          ? "That setup code isn't right."
          : message(err),
      );
    }
  };

  const finish = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    if (password !== password2) return setError("The passwords don't match.");
    try {
      await api("/auth/setup", { body: { code: code.trim(), password, totp } });
      onDone();
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 403
          ? "That code didn't match. Try the next one."
          : message(err),
      );
      setTotp("");
    }
  };

  return (
    <div className="login">
      {!secret ? (
        <form className="login-card" onSubmit={start}>
          <div className="brand-mark">
            <Icon name="hat" />
          </div>
          <h2>Set up Hatbot</h2>
          <div className="muted" style={{ fontSize: 12.5 }}>
            Enter the setup code from the brain's log:{" "}
            <span className="mono">journalctl -u hatbot-brain</span>
          </div>
          <input
            className="field"
            placeholder="Setup code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
          {error && <div className="form-error">{error}</div>}
          <button className="btn accent" type="submit" disabled={!code.trim()}>
            Continue
          </button>
        </form>
      ) : (
        <form className="login-card" onSubmit={finish}>
          <h2>Set up Hatbot</h2>
          <div className="muted" style={{ fontSize: 12.5 }}>
            Scan this with your authenticator app.
          </div>
          {/* biome-ignore lint/security/noDangerouslySetInnerHtml: SVG generated locally by qrcode */}
          <div className="qr" dangerouslySetInnerHTML={{ __html: qr }} />
          <div className="secret">{secret.secret}</div>
          <input
            className="field"
            type="password"
            placeholder="Password (12+ characters)"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <input
            className="field"
            type="password"
            placeholder="Password again"
            autoComplete="new-password"
            value={password2}
            onChange={(e) => setPassword2(e.target.value)}
          />
          <div className="muted" style={{ fontSize: 12 }}>
            Code from your authenticator
          </div>
          <OtpInput value={totp} onChange={setTotp} />
          {error && <div className="form-error">{error}</div>}
          <button
            className="btn accent"
            type="submit"
            disabled={password.length < 12 || totp.length !== 6}
          >
            Finish
          </button>
        </form>
      )}
    </div>
  );
}
