import type { SetupStartResponse } from "@hatbot/shared";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { ApiError, api } from "../api";
import { Icon } from "../icons";
import { backspace, pasted, slots, typed } from "../otp";

/** Six boxes for a code. `value` is its digits, six when it's complete; "" empties the boxes. */
export function OtpInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  // Each box holds its own digit, so fixing one never shifts the rest.
  const [code, setCode] = useState(value);
  useEffect(() => {
    if (value === "") setCode("");
  }, [value]);
  const apply = (step: { code: string; focus: number }) => {
    setCode(step.code);
    onChange(step.code.replace(/\D/g, ""));
    refs.current[step.focus]?.focus();
  };
  return (
    <fieldset className="otp" aria-label="Code from your authenticator">
      {slots(code).map((d, i) => (
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
          onFocus={(e) => e.target.select()}
          onChange={(e) => apply(typed(code, i, e.target.value))}
          onPaste={(e) => {
            e.preventDefault();
            apply(pasted(code, i, e.clipboardData.getData("text")));
          }}
          onKeyDown={(e) => {
            if (e.key === "Backspace" && !d) {
              e.preventDefault();
              apply(backspace(code, i));
            } else if (e.key === "ArrowLeft" && i > 0) refs.current[i - 1]?.focus();
            else if (e.key === "ArrowRight" && i < 5) refs.current[i + 1]?.focus();
          }}
        />
      ))}
    </fieldset>
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
          aria-label="Password"
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

/**
 * For an authenticator on this device, where there's no code to scan: a link that opens it, and the
 * secret in groups of four to copy.
 */
export function AddToAuthenticator({ uri, secret }: { uri: string; secret: string }) {
  const shown = useRef<HTMLElement>(null);
  const [copied, setCopied] = useState(false);
  const copy = () => {
    // Without a secure origin there's no clipboard: the secret is selected to copy by hand.
    const select = () => shown.current && getSelection()?.selectAllChildren(shown.current);
    if (!navigator.clipboard) return select();
    navigator.clipboard.writeText(secret).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }, select);
  };
  return (
    <>
      <a className="btn" href={uri}>
        Add to authenticator
      </a>
      <div className="copyable">
        <code className="secret" ref={shown}>
          {secret.match(/.{1,4}/g)?.join(" ")}
        </code>
        <button type="button" className="btn sm ghost" onClick={copy}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </>
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
            aria-label="Setup code"
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
            Scan this with your authenticator app, or add it on this device.
          </div>
          {/* biome-ignore lint/security/noDangerouslySetInnerHtml: SVG generated locally by qrcode */}
          <div className="qr" dangerouslySetInnerHTML={{ __html: qr }} />
          <AddToAuthenticator uri={secret.uri} secret={secret.secret} />
          <input
            className="field"
            type="password"
            placeholder="Password (12+ characters)"
            aria-label="Password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <input
            className="field"
            type="password"
            placeholder="Password again"
            aria-label="Password again"
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
