// Settings → Password and sign-ins: a new password or authenticator, and where you're signed in.
import type { Session, SetupStartResponse, SignedOutOthers } from "@hatbot/shared";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { ApiError, api } from "../api";
import { ask } from "../confirm";
import { deviceName } from "../device";
import { Icon } from "../icons";
import { LoadError, loadErrorText } from "../load";
import { navigate } from "../router";
import type { Toast } from "../toast";
import { AddToAuthenticator, OtpInput } from "./Login";

const errorText = (err: unknown) =>
  err instanceof ApiError ? err.message : "Couldn't reach Hatbot.";
const changed = (what: string, ended: number) =>
  ended ? `${what}. Every other browser and app is signed out.` : what;
const since = (iso: string) =>
  `Since ${new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}`;

/**
 * Signs a browser out; what went wrong, or null. One signed out already, from another tab or by
 * expiring, is no error: the list shows it once it loads again.
 */
export async function signOut(id: number): Promise<string | null> {
  try {
    await api(`/auth/sessions/${id}`, { method: "DELETE" });
    return null;
  } catch (err) {
    return err instanceof ApiError && err.status === 404 ? null : errorText(err);
  }
}

export function Account({ toast }: { toast: Toast }) {
  // A change signs out the other sessions, so the list loads again.
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);
  return (
    <section className="view">
      <div className="page narrow">
        <div className="page-head">
          <button type="button" className="btn sm ghost back" onClick={() => navigate("/settings")}>
            <Icon name="chevron" />
            Settings
          </button>
        </div>
        <PasswordForm toast={toast} onChanged={reload} />
        <AuthenticatorForm toast={toast} onChanged={reload} />
        <Sessions toast={toast} version={version} />
      </div>
    </section>
  );
}

function PasswordForm({ toast, onChanged }: { toast: Toast; onChanged: () => void }) {
  const [password, setPassword] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [totp, setTotp] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    if (next !== again) return setError("The new passwords don't match.");
    setBusy(true);
    try {
      const r = await api<SignedOutOthers>("/auth/password", {
        body: { password, totp, newPassword: next },
      });
      setPassword("");
      setNext("");
      setAgain("");
      toast(changed("Password changed", r.ended));
      onChanged();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setTotp("");
      setBusy(false);
    }
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

function AuthenticatorForm({ toast, onChanged }: { toast: Toast; onChanged: () => void }) {
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [next, setNext] = useState<SetupStartResponse | null>(null);
  const [qr, setQr] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!next) return setQr("");
    import("qrcode").then((QRCode) =>
      QRCode.toString(next.uri, { type: "svg", margin: 0 }).then(setQr),
    );
  }, [next]);

  const start = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      setNext(await api<SetupStartResponse>("/auth/totp/start", { body: { password, totp } }));
      setPassword("");
    } catch (err) {
      setError(errorText(err));
    } finally {
      setTotp("");
      setBusy(false);
    }
  };

  const finish = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const r = await api<SignedOutOthers>("/auth/totp", { body: { totp: code } });
      setNext(null);
      toast(changed("Authenticator changed", r.ended));
      onChanged();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setCode("");
      setBusy(false);
    }
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

function Sessions({ toast, version }: { toast: Toast; version: number }) {
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [loadError, setLoadError] = useState("");

  const load = useCallback(() => {
    setLoadError("");
    api<Session[]>("/auth/sessions").then(setSessions, (err) => setLoadError(loadErrorText(err)));
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: loads again after a change signs others out
  useEffect(load, [load, version]);

  const end = async (s: Session) => {
    const error = await signOut(s.id);
    if (error) toast(error, "error");
    load();
  };

  const endOthers = async () => {
    if (
      !(await ask({
        text: "Sign out every other browser and app? Apps will need to sign in again.",
        ok: "Sign out",
      }))
    )
      return;
    try {
      const r = await api<SignedOutOthers>("/auth/sign-out-others", { body: {} });
      if (r.ended) toast("Signed out everywhere else");
      else toast("Nowhere else was signed in", "info");
    } catch (err) {
      toast(errorText(err), "error");
    }
    load();
  };

  if (loadError) return <LoadError error={loadError} retry={load} />;
  if (!sessions) return null;
  return (
    <section className="group">
      <h2>Signed in</h2>
      <div className="group-box">
        {sessions.map((s) => (
          <div className="row" key={s.id}>
            <div className="txt">
              <b>{deviceName(s.userAgent)}</b>
            </div>
            <span className="val">{s.current ? "This browser" : since(s.createdAt)}</span>
            {!s.current && (
              <button type="button" className="btn sm danger-text" onClick={() => end(s)}>
                Sign out
              </button>
            )}
          </div>
        ))}
        <div className="row">
          <div className="txt">
            <b>Every other browser and app</b>
          </div>
          <button type="button" className="btn sm danger-text" onClick={endOthers}>
            Sign out
          </button>
        </div>
      </div>
    </section>
  );
}
