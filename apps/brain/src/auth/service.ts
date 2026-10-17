import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { ApiToken } from "@hatbot/shared";
import { type Db, now } from "../db";
import { newTotpSecret, totpUri, verifyTotp } from "./totp";

export const SESSION_DAYS = 30;
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const randomToken = (prefix: string) => prefix + randomBytes(32).toString("base64url");
const sameText = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export type Principal = { kind: "session"; id: number } | { kind: "token"; id: number };

const keyOf = (p: Principal) => `${p.kind} ${p.id}`;

type OwnerRow = { password_hash: string; totp_secret: string; totp_last_step: number };

export class AuthService {
  /** One-time code that unlocks first-run setup; printed to the log while no owner exists. */
  readonly setupCode = randomBytes(6).toString("hex");
  private pendingSecret: string | null = null;
  private deviceKey: Buffer | null = null;
  /**
   * A private address that passed on X-Forwarded-For without being in HATBOT_TRUSTED_PROXIES: your
   * reverse proxy, most likely, which makes every sign-in count as coming from one address.
   */
  untrustedProxy: string | null = null;
  /** Live sockets, by the session or token that opened them, to close when it ends. */
  private sockets = new Map<string, Set<() => void>>();

  constructor(
    private db: Db,
    private clock: () => number = Date.now,
  ) {}

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
    const hash = await Bun.password.hash(password, { algorithm: "argon2id" });
    this.db
      .query(
        "INSERT INTO owner (id, password_hash, totp_secret, totp_last_step) VALUES (1, ?, ?, ?)",
      )
      .run(hash, this.pendingSecret, step);
    this.pendingSecret = null;
    return true;
  }

  /** Checks password and TOTP. A TOTP code can't be used twice. */
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
    // Only advance if nobody used this step concurrently.
    const res = this.db
      .query("UPDATE owner SET totp_last_step = ? WHERE id = 1 AND totp_last_step < ?")
      .run(step, step);
    return res.changes === 1;
  }

  /** A browser or app that has signed in here: a random id, signed so one can't be made up. */
  newDevice(): string {
    const id = randomBytes(16).toString("base64url");
    return `${id}.${this.signDevice(id)}`;
  }

  /** The id in a cookie newDevice() made, or null. */
  knownDevice(cookie: string | undefined): string | null {
    const [id, sig, ...rest] = cookie?.split(".") ?? [];
    return id && sig && !rest.length && sameText(sig, this.signDevice(id)) ? id : null;
  }

  private signDevice(id: string): string {
    if (!this.deviceKey) {
      this.db
        .query("INSERT INTO settings (key, value) VALUES ('device_key', ?) ON CONFLICT DO NOTHING")
        .run(randomBytes(32).toString("hex"));
      const row = this.db
        .query<{ value: string }, []>("SELECT value FROM settings WHERE key = 'device_key'")
        .get();
      this.deviceKey = Buffer.from(row?.value ?? "", "hex");
    }
    return createHmac("sha256", this.deviceKey).update(id).digest("base64url");
  }

  /** Closes a live socket when the session or token it was opened with ends. Returns how to forget it. */
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

  /** Deletes expired sessions; the brain calls it hourly. */
  prune() {
    const rows = this.db
      .query<{ id: number }, [string]>("DELETE FROM sessions WHERE expires_at <= ? RETURNING id")
      .all(new Date(this.clock()).toISOString());
    this.ended(
      "session",
      rows.map((r) => r.id),
    );
  }

  /** The session, and whether its expiry moved on, so its cookie should too. */
  resolveSession(token: string): (Principal & { renewed?: true }) | null {
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
    if (Date.parse(row.expires_at) - nowMs < (SESSION_DAYS - 1) * 86400_000) {
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
      .query<{ id: number }, [string]>("SELECT id FROM api_tokens WHERE token_hash = ?")
      .get(sha256(token));
    if (!row) return null;
    this.db.query("UPDATE api_tokens SET last_used_at = ? WHERE id = ?").run(now(), row.id);
    return { kind: "token", id: row.id };
  }
}

/** Counts failed logins per key in a sliding window. */
export class FailureLimiter {
  private failures = new Map<string, number[]>();

  constructor(
    private max: number,
    private windowMs: number,
    private clock: () => number = Date.now,
    /** Told when a key reaches the limit. */
    private onBlocked?: (key: string) => void,
  ) {}

  blocked(key: string): boolean {
    return this.recent(key).length >= this.max;
  }

  fail(key: string) {
    const list = this.recent(key);
    list.push(this.clock());
    this.failures.set(key, list);
    if (list.length === this.max) this.onBlocked?.(key);
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
