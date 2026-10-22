// The URL is a secret: whoever holds it can fake "up".
import type { Db } from "./db";

const INTERVAL_MS = 60_000;
const TIMEOUT_MS = 10_000;

export type PingResult = {
  at: string;
  /** What the brain said: down when its database didn't answer. */
  status: "up" | "down";
  msg: string;
  error: string | null;
};

export type PingDeps = {
  db: Db;
  url?: string | undefined;
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  clock?: () => number;
};

export const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export class DeadManPing {
  private last: PingResult | null = null;
  private sentAt = 0;
  private sending = false;
  private clock: () => number;
  url: string;

  constructor(private d: PingDeps) {
    this.clock = d.clock ?? Date.now;
    this.url = d.url ?? "";
  }

  get configured() {
    return Boolean(this.url);
  }

  lastPing(): PingResult | null {
    return this.last;
  }

  /** Pings even while paused: paused is alive. */
  tick() {
    if (!this.url || this.sending || this.clock() - this.sentAt < INTERVAL_MS) return;
    void this.send();
  }

  /** Never throws: a failed ping is logged and kept for Check everything. */
  async send(): Promise<PingResult | null> {
    const url = this.url;
    if (!url) return null;
    this.sending = true;
    this.sentAt = this.clock();
    let status: PingResult["status"] = "up";
    let msg = "OK";
    try {
      this.d.db.query("SELECT 1 FROM schema_migrations LIMIT 1").get();
    } catch (err) {
      status = "down";
      msg = `Database: ${errorText(err)}`.slice(0, 200);
    }
    let error: string | null = null;
    try {
      const u = new URL(url);
      u.searchParams.set("status", status);
      u.searchParams.set("msg", msg);
      const res = await (this.d.fetch ?? fetch)(u.toString(), {
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) error = `It answered ${res.status}.`;
      await res.body?.cancel();
    } catch (err) {
      error = errorText(err);
    }
    if (error) console.error(`dead-man ping failed: ${error}`);
    this.last = { at: new Date(this.sentAt).toISOString(), status, msg, error };
    this.sending = false;
    return this.last;
  }
}
