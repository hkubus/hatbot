import { createHash, createHmac, randomBytes } from "node:crypto";
import type { ApiToken, Session } from "@hatbot/shared";
import type { Db } from "../db";
import { sameText, secretKey } from "./keys";
import { newTotpSecret, totpUri, verifyTotp } from "./totp";

export const SESSION_DAYS = 30;
const LAST_USED_MS = 5 * 60_000;
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const randomToken = (prefix: string) => prefix + randomBytes(32).toString("base64url");

export type Principal = { kind: "session"; id: number } | { kind: "token"; id: number };

const keyOf = (p: Principal) => `${p.kind} ${p.id}`;
const TOTP_CHANGE_MS = 10 * 60_000;

type OwnerRow = { password_hash: string; totp_secret: string; totp_last_step: number };

/** Argon2id's cost; left out, Bun's defaults. Only tests pass a cheaper one. */
export type PasswordCost = { memoryCost: number; timeCost: number };

export class AuthService {
  /** One-time code that unlocks first-run setup; printed to the log while no owner exists. */
  readonly setupCode = randomBytes(6).toString("hex");
  private pendingSecret: string | null = null;
  private deviceKey: Buffer | null = null;
  /**
   * An untrusted proxy makes every sign-in count as coming from one address. Anyone on your network can
   * send the header too, so Check everything only goes by its own request through the public address.
   */
  untrustedProxy: { ip: string; at: number } | null = null;
  private sockets = new Map<string, Set<() => void>>();
  private totpChange: { secret: string; for: string; until: number; tries: number } | null = null;

  constructor(
    private db: Db,
    private clock: () => number = Date.now,
    private passwordCost?: PasswordCost,
  ) {}

  private hash(password: string) {
    return Bun.password.hash(password, { algorithm: "argon2id", ...this.passwordCost });
  }

  forwardedBy(ip: string) {
    if (this.untrustedProxy?.ip !== ip)
      console.warn(
        `${ip} forwards requests but isn't in HATBOT_TRUSTED_PROXIES, so sign-in limits count every client as ${ip}`,
      );
    this.untrustedProxy = { ip, at: this.clock() };
  }

  isSetUp(): boolean {
    return this.db.query("SELECT 1 FROM owner WHERE id = 1").get() !== null;
  }

  startSetup(code: string): { secret: string; uri: string } | null {
    if (this.isSetUp() || !sameText(code, this.setupCode)) return null;
    this.pendingSecret ??= newTotpSecret();
    return { secret: this.pendingSecret, uri: totpUri(this.pendingSecret) };
  }

  async finishSetup(code: string, password: string, totp: string): Promise<boolean> {
    if (this.isSetUp() || !sameText(code, this.setupCode) || !this.pendingSecret) return false;
    const step = verifyTotp(this.pendingSecret, totp, this.clock());
    if (step === null) return false;
    const hash = await this.hash(password);
    this.db
      .query(
        "INSERT INTO owner (id, password_hash, totp_secret, totp_last_step) VALUES (1, ?, ?, ?)",
      )
      .run(hash, this.pendingSecret, step);
    this.pendingSecret = null;
    return true;
  }

  /** A TOTP code can't be used twice. */
  async checkCredentials(password: string, totp: string): Promise<boolean> {
    const owner = this.db
      .query<OwnerRow, []>(
        "SELECT password_hash, totp_secret, totp_last_step FROM owner WHERE id = 1",
      )
      .get();
    if (!owner) return false;
    const passwordOk = await Bun.password.verify(password, owner.password_hash);
    const step = verifyTotp(owner.totp_secret, totp, this.clock());
    if (!passwordOk || step === null || step <= owner.totp_last_step) return false;
    // Only advance if nobody used this step concurrently, and the password and authenticator are still
    // the ones checked: a change while the check ran signs out everything but the changer.
    const res = this.db
      .query(
        `UPDATE owner SET totp_last_step = ? WHERE id = 1 AND totp_last_step < ?
         AND password_hash = ? AND totp_secret = ?`,
      )
      .run(step, step, owner.password_hash, owner.totp_secret);
    return res.changes === 1;
  }

  /** Callers check the old password and a code first (checkCredentials). */
  async changePassword(password: string) {
    const hash = await this.hash(password);
    this.db.query("UPDATE owner SET password_hash = ? WHERE id = 1").run(hash);
  }

  /**
   * The secret takes over only once a code from it comes back (finishTotpChange), so a mistyped scan
   * doesn't lock you out. Callers check the password and a code first.
   */
  startTotpChange(p: Principal): { secret: string; uri: string } {
    const secret = newTotpSecret();
    this.totpChange = { secret, for: keyOf(p), until: this.clock() + TOTP_CHANGE_MS, tries: 0 };
    return { secret, uri: totpUri(secret) };
  }

  finishTotpChange(p: Principal, code: string): boolean {
    const change = this.totpChange;
    if (!change || change.for !== keyOf(p) || change.until < this.clock()) return false;
    const step = verifyTotp(change.secret, code, this.clock());
    if (step === null) {
      // Codes can't be guessed at: a few wrong ones and it starts again.
      if (++change.tries >= 5) this.totpChange = null;
      return false;
    }
    this.db
      .query("UPDATE owner SET totp_secret = ?, totp_last_step = ? WHERE id = 1")
      .run(change.secret, step);
    this.totpChange = null;
    return true;
  }

  listSessions(current?: Principal): Session[] {
    return this.db
      .query<Omit<Session, "current">, [string]>(
        `SELECT id, user_agent AS userAgent, created_at AS createdAt, expires_at AS expiresAt
         FROM sessions WHERE expires_at > ? ORDER BY id DESC`,
      )
      .all(new Date(this.clock()).toISOString())
      .map((r) => ({ ...r, current: current?.kind === "session" && current.id === r.id }));
  }

  endSession(id: number): boolean {
    if (this.db.query("DELETE FROM sessions WHERE id = ?").run(id).changes !== 1) return false;
    this.ended("session", [id]);
    return true;
  }

  /**
   * Also forgets which devices signed in here before: one that isn't yours would keep a sign-in limit
   * of its own. A change of password or authenticator comes here too.
   */
  endOthers(keep: Principal): number {
    this.db.query("DELETE FROM settings WHERE key = 'device_key'").run();
    this.deviceKey = null;
    const sessions = this.db
      .query<{ id: number }, [number]>("DELETE FROM sessions WHERE id != ? RETURNING id")
      .all(keep.kind === "session" ? keep.id : -1)
      .map((r) => r.id);
    const tokens = this.db
      .query<{ id: number }, [number]>("DELETE FROM api_tokens WHERE id != ? RETURNING id")
      .all(keep.kind === "token" ? keep.id : -1)
      .map((r) => r.id);
    this.ended("session", sessions);
    this.ended("token", tokens);
    return sessions.length + tokens.length;
  }

  /** Whether a session or token still stands, for a request that was let in before it ended. */
  alive(p: Principal): boolean {
    return p.kind === "session"
      ? this.db
          .query("SELECT 1 FROM sessions WHERE id = ? AND expires_at > ?")
          .get(p.id, new Date(this.clock()).toISOString()) !== null
      : this.db.query("SELECT 1 FROM api_tokens WHERE id = ?").get(p.id) !== null;
  }

  /** A random device id, signed so one can't be made up. */
  newDevice(): string {
    const id = randomBytes(16).toString("base64url");
    return `${id}.${this.signDevice(id)}`;
  }

  knownDevice(cookie: string | undefined): string | null {
    const [id, sig, ...rest] = cookie?.split(".") ?? [];
    return id && sig && !rest.length && sameText(sig, this.signDevice(id)) ? id : null;
  }

  private signDevice(id: string): string {
    this.deviceKey ??= secretKey(this.db, "device_key");
    return createHmac("sha256", this.deviceKey).update(id).digest("base64url");
  }

  onEnd(p: Principal, close: () => void): () => void {
    const key = keyOf(p);
    const set = this.sockets.get(key) ?? new Set();
    set.add(close);
    this.sockets.set(key, set);
    return () => {
      set.delete(close);
      if (!set.size && this.sockets.get(key) === set) this.sockets.delete(key);
    };
  }

  private ended(kind: Principal["kind"], ids: number[]) {
    for (const id of ids) {
      const key = keyOf({ kind, id });
      const set = this.sockets.get(key);
      this.sockets.delete(key);
      for (const close of set ?? []) close();
    }
  }

  createSession(userAgent: string | null): string {
    this.prune();
    const token = randomToken("hbs_");
    const expires = new Date(this.clock() + SESSION_DAYS * 86400_000).toISOString();
    this.db
      .query("INSERT INTO sessions (token_hash, user_agent, expires_at) VALUES (?, ?, ?)")
      .run(sha256(token), userAgent, expires);
    return token;
  }

  deleteSession(token: string) {
    const rows = this.db
      .query<{ id: number }, [string]>("DELETE FROM sessions WHERE token_hash = ? RETURNING id")
      .all(sha256(token));
    this.ended(
      "session",
      rows.map((r) => r.id),
    );
  }

  prune() {
    const rows = this.db
      .query<{ id: number }, [string]>("DELETE FROM sessions WHERE expires_at <= ? RETURNING id")
      .all(new Date(this.clock()).toISOString());
    this.ended(
      "session",
      rows.map((r) => r.id),
    );
  }

  /** `renewed`: the expiry moved on, so the cookie should too. */
  resolveSession(token: string, renew = true): (Principal & { renewed?: true }) | null {
    const row = this.db
      .query<{ id: number; expires_at: string }, [string]>(
        "SELECT id, expires_at FROM sessions WHERE token_hash = ?",
      )
      .get(sha256(token));
    if (!row) return null;
    const nowMs = this.clock();
    if (Date.parse(row.expires_at) <= nowMs) {
      this.db.query("DELETE FROM sessions WHERE id = ?").run(row.id);
      this.ended("session", [row.id]);
      return null;
    }
    // Sliding expiry, refreshed at most daily.
    if (renew && Date.parse(row.expires_at) - nowMs < (SESSION_DAYS - 1) * 86400_000) {
      const expires = new Date(nowMs + SESSION_DAYS * 86400_000).toISOString();
      this.db.query("UPDATE sessions SET expires_at = ? WHERE id = ?").run(expires, row.id);
      return { kind: "session", id: row.id, renewed: true };
    }
    return { kind: "session", id: row.id };
  }

  createToken(name: string): ApiToken & { token: string } {
    const token = randomToken("hbt_");
    const row = this.db
      .query<{ id: number; created_at: string }, [string, string]>(
        "INSERT INTO api_tokens (name, token_hash) VALUES (?, ?) RETURNING id, created_at",
      )
      .get(name, sha256(token));
    if (!row) throw new Error("token insert failed");
    return { id: row.id, name, createdAt: row.created_at, lastUsedAt: null, token };
  }

  listTokens(): ApiToken[] {
    return this.db
      .query<ApiToken, []>(
        "SELECT id, name, created_at AS createdAt, last_used_at AS lastUsedAt FROM api_tokens ORDER BY id",
      )
      .all();
  }

  deleteToken(id: number): boolean {
    if (this.db.query("DELETE FROM api_tokens WHERE id = ?").run(id).changes !== 1) return false;
    this.ended("token", [id]);
    return true;
  }

  resolveToken(token: string): Principal | null {
    const row = this.db
      .query<{ id: number; last_used_at: string | null }, [string]>(
        "SELECT id, last_used_at FROM api_tokens WHERE token_hash = ?",
      )
      .get(sha256(token));
    if (!row) return null;
    const nowMs = this.clock();
    if (!row.last_used_at || nowMs - Date.parse(row.last_used_at) >= LAST_USED_MS)
      this.db
        .query("UPDATE api_tokens SET last_used_at = ? WHERE id = ?")
        .run(new Date(nowMs).toISOString(), row.id);
    return { kind: "token", id: row.id };
  }
}

const TELL_EVERY_MS = 3600_000;

export class FailureLimiter {
  private failures = new Map<string, number[]>();
  private toldAt = new Map<string, number>();

  constructor(
    private max: number,
    private windowMs: number,
    private clock: () => number = Date.now,
    private onBlocked?: (key: string) => void,
  ) {}

  blocked(key: string): boolean {
    return this.recent(key).length >= this.max;
  }

  /** Counts a failure; one counted before it's checked is taken back with forgive() or kept with stood(). */
  fail(key: string) {
    const list = this.recent(key);
    list.push(this.clock());
    this.failures.set(key, list);
  }

  /**
   * A failure that stood once it was checked. Someone failing as fast as the window lets them keeps
   * the key at its limit, so onBlocked hears about it hourly, not each time.
   */
  stood(key: string) {
    if (!this.onBlocked || !this.blocked(key)) return;
    const now = this.clock();
    if (now - (this.toldAt.get(key) ?? -Infinity) < TELL_EVERY_MS) return;
    this.toldAt.set(key, now);
    this.onBlocked(key);
  }

  /** Takes back one failure: an attempt counted before it was checked, which turned out right. */
  forgive(key: string) {
    const list = this.recent(key);
    list.pop();
    if (list.length) this.failures.set(key, list);
    else this.failures.delete(key);
  }

  reset(key: string) {
    this.failures.delete(key);
  }

  private recent(key: string): number[] {
    const cutoff = this.clock() - this.windowMs;
    return (this.failures.get(key) ?? []).filter((t) => t > cutoff);
  }
}
