import { createHash, randomBytes } from "node:crypto";
import type { ApiToken } from "@hatbot/shared";
import { type Db, now } from "../db";
import { newTotpSecret, totpUri, verifyTotp } from "./totp";

const SESSION_DAYS = 30;
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const randomToken = (prefix: string) => prefix + randomBytes(32).toString("base64url");

export type Principal = { kind: "session"; id: number } | { kind: "token"; id: number };

type OwnerRow = { password_hash: string; totp_secret: string; totp_last_step: number };

export class AuthService {
  /** One-time code that unlocks first-run setup; printed to the log while no owner exists. */
  readonly setupCode = randomBytes(6).toString("hex");
  private pendingSecret: string | null = null;

  constructor(
    private db: Db,
    private clock: () => number = Date.now,
  ) {}

  isSetUp(): boolean {
    return this.db.query("SELECT 1 FROM owner WHERE id = 1").get() !== null;
  }

  startSetup(code: string): { secret: string; uri: string } | null {
    if (this.isSetUp() || code !== this.setupCode) return null;
    this.pendingSecret ??= newTotpSecret();
    return { secret: this.pendingSecret, uri: totpUri(this.pendingSecret) };
  }

  async finishSetup(code: string, password: string, totp: string): Promise<boolean> {
    if (this.isSetUp() || code !== this.setupCode || !this.pendingSecret) return false;
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

  createSession(userAgent: string | null): string {
    const token = randomToken("hbs_");
    const expires = new Date(this.clock() + SESSION_DAYS * 86400_000).toISOString();
    this.db
      .query("INSERT INTO sessions (token_hash, user_agent, expires_at) VALUES (?, ?, ?)")
      .run(sha256(token), userAgent, expires);
    return token;
  }

  deleteSession(token: string) {
    this.db.query("DELETE FROM sessions WHERE token_hash = ?").run(sha256(token));
  }

  resolveSession(token: string): Principal | null {
    const row = this.db
      .query<{ id: number; expires_at: string }, [string]>(
        "SELECT id, expires_at FROM sessions WHERE token_hash = ?",
      )
      .get(sha256(token));
    if (!row) return null;
    const nowMs = this.clock();
    if (Date.parse(row.expires_at) <= nowMs) {
      this.db.query("DELETE FROM sessions WHERE id = ?").run(row.id);
      return null;
    }
    // Sliding expiry, refreshed at most daily.
    if (Date.parse(row.expires_at) - nowMs < (SESSION_DAYS - 1) * 86400_000) {
      const expires = new Date(nowMs + SESSION_DAYS * 86400_000).toISOString();
      this.db.query("UPDATE sessions SET expires_at = ? WHERE id = ?").run(expires, row.id);
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
    return this.db.query("DELETE FROM api_tokens WHERE id = ?").run(id).changes === 1;
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
  ) {}

  blocked(key: string): boolean {
    return this.recent(key).length >= this.max;
  }

  fail(key: string) {
    const list = this.recent(key);
    list.push(this.clock());
    this.failures.set(key, list);
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
