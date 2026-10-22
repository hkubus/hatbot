import type { SetupStartResponse, SignedOutOthers } from "@hatbot/shared";
import { type FormEvent, useEffect, useState } from "react";
import { useAction } from "../action";
import { api } from "../api";
import type { Toast } from "../toast";
import { BackHead } from "../ui";
import { AddToAuthenticator, OtpInput } from "./Login";

const changed = (what: string, ended: number) =>
  ended ? `${what}. Every other browser and app is signed out.` : what;

export function Account({ toast }: { toast: Toast }) {
  return (
    <section className="view">
      <div className="page narrow">
        <BackHead to="/settings" label="Settings" />
        <PasswordForm toast={toast} />
        <AuthenticatorForm toast={toast} />
      </div>
    </section>
  );
}

function PasswordForm({ toast }: { toast: Toast }) {
  const [password, setPassword] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [totp, setTotp] = useState("");
  const { busy, error, setError, run } = useAction();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (next !== again) return setError("The new passwords don't match.");
    await run(async () => {
      const r = await api<SignedOutOthers>("/auth/password", {
        body: { password, totp, newPassword: next },
      });
      setPassword("");
      setNext("");
      setAgain("");
      toast(changed("Password changed", r.ended));
    });
    setTotp("");
  };

  return (
    <form className="panel form" onSubmit={submit}>
      <h3 className="section-title">Password</h3>
      <label>
        <span className="label">Current password</span>
        <input
          className="field"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </label>
      <label>
        <span className="label">New password, 12 characters or more</span>
        <input
          className="field"
          type="password"
          autoComplete="new-password"
          value={next}
          onChange={(e) => setNext(e.target.value)}
        />
      </label>
      <label>
        <span className="label">New password again</span>
        <input
          className="field"
          type="password"
          autoComplete="new-password"
          value={again}
          onChange={(e) => setAgain(e.target.value)}
        />
      </label>
      <span className="label">Code from your authenticator</span>
      <OtpInput value={totp} onChange={setTotp} />
      {error && <div className="form-error">{error}</div>}
      <div className="form-actions">
        <button
          type="submit"
          className="btn accent"
          disabled={busy || !password || next.length < 12 || totp.length !== 6}
        >
          Change password
        </button>
      </div>
    </form>
  );
}

function AuthenticatorForm({ toast }: { toast: Toast }) {
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [next, setNext] = useState<SetupStartResponse | null>(null);
  const [qr, setQr] = useState("");
  const [code, setCode] = useState("");
  const { busy, error, setError, run } = useAction();

  useEffect(() => {
    if (!next) return setQr("");
    import("qrcode").then((QRCode) =>
      QRCode.toString(next.uri, { type: "svg", margin: 0 }).then(setQr),
    );
  }, [next]);

  const start = async (e: FormEvent) => {
    e.preventDefault();
    await run(async () => {
      setNext(await api<SetupStartResponse>("/auth/totp/start", { body: { password, totp } }));
      setPassword("");
    });
    setTotp("");
  };

  const finish = async (e: FormEvent) => {
    e.preventDefault();
    await run(async () => {
      const r = await api<SignedOutOthers>("/auth/totp", { body: { totp: code } });
      setNext(null);
      toast(changed("Authenticator changed", r.ended));
    });
    setCode("");
  };

  if (!next)
    return (
      <form className="panel form" onSubmit={start}>
        <h3 className="section-title">Authenticator</h3>
        <label>
          <span className="label">Password</span>
          <input
            className="field"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <span className="label">Code from your authenticator</span>
        <OtpInput value={totp} onChange={setTotp} />
        {error && <div className="form-error">{error}</div>}
        <div className="form-actions">
          <button type="submit" className="btn" disabled={busy || !password || totp.length !== 6}>
            Set up a new one
          </button>
        </div>
      </form>
    );

  return (
    <form className="panel form" onSubmit={finish}>
      <h3 className="section-title">Authenticator</h3>
      <div className="muted">
        Scan this with the new authenticator, or add it on this device, and enter the code it shows.
        The old one works until then.
      </div>
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: SVG generated locally by qrcode */}
      <div className="qr" dangerouslySetInnerHTML={{ __html: qr }} />
      <AddToAuthenticator uri={next.uri} secret={next.secret} />
      <span className="label">Code from the new authenticator</span>
      <OtpInput value={code} onChange={setCode} />
      {error && <div className="form-error">{error}</div>}
      <div className="form-actions">
        <button
          type="button"
          className="btn ghost"
          onClick={() => {
            setNext(null);
            setError("");
          }}
        >
          Cancel
        </button>
        <button type="submit" className="btn accent" disabled={busy || code.length !== 6}>
          Use it
        </button>
      </div>
    </form>
  );
}
