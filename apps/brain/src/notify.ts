import type { NtfyConfig } from "./secrets";

export type NtfyAction =
  | { action: "view"; label: string; url: string; clear?: boolean }
  | {
      action: "http";
      label: string;
      url: string;
      method: "POST";
      headers?: Record<string, string>;
      body: string;
      clear?: boolean;
    };

export type Notification = {
  title: string;
  message: string;
  priority?: 1 | 2 | 3 | 4 | 5;
  tags?: string[];
  click?: string;
  actions?: NtfyAction[];
};

export interface Notifier {
  send(n: Notification): Promise<void>;
}

/**
 * A topic named by hand could be guessed, and on a server that lets anyone read, read. One is random
 * only with a long run that looks it: 16 hex digits and letters (deploy.sh's hatbot-<24 hex>), or 22
 * letters and digits of both cases.
 */
export function guessableTopic(topic: string): boolean {
  const hex = (topic.match(/[0-9a-f]{16,}|[0-9A-F]{16,}/g) ?? []).some(
    (run) => /[0-9]/.test(run) && /[a-f]/i.test(run),
  );
  const mixed = (topic.match(/[\w-]{22,}/g) ?? []).some((run) =>
    [/[a-z]/, /[A-Z]/, /[0-9]/].every((kind) => kind.test(run)),
  );
  return !hex && !mixed;
}

export class NtfyNotifier implements Notifier {
  private url = "";
  /** No shared default: whoever reads the topic sees every notification, Approve buttons included. */
  topic = "";
  private token = "";

  constructor(
    config: NtfyConfig,
    private fetcher: typeof fetch = fetch,
    private clock: () => number = Date.now,
  ) {
    this.configure(config);
  }

  configure(config: NtfyConfig) {
    this.url = config.url.replace(/\/$/, "");
    this.topic = config.topic;
    this.token = config.token;
    if (this.url && !this.topic) console.warn("No ntfy topic is set, so no notifications are sent");
  }

  get configured() {
    return Boolean(this.url);
  }

  get hasToken() {
    return Boolean(this.token);
  }

  async health(): Promise<void> {
    const res = await this.fetcher(`${this.url}/v1/health`, {
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json().catch(() => ({}))) as { healthy?: boolean };
    if (!res.ok || body.healthy !== true) throw new Error(`ntfy answered ${res.status}`);
  }

  /** Asks only for messages from now on, so nothing that was sent comes back. */
  async readableByAnyone(): Promise<boolean> {
    const since = Math.floor(this.clock() / 1000);
    const res = await this.fetcher(
      `${this.url}/${encodeURIComponent(this.topic)}/json?poll=1&since=${since}`,
      { signal: AbortSignal.timeout(10_000) },
    );
    await res.body?.cancel().catch(() => {});
    if (res.ok) return true;
    if (res.status === 401 || res.status === 403) return false;
    throw new Error(`ntfy answered ${res.status}`);
  }

  async send(n: Notification) {
    if (!this.url || !this.topic) return;
    try {
      const res = await this.fetcher(this.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        },
        body: JSON.stringify({ topic: this.topic, ...n }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok)
        console.error(`ntfy returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
    } catch (err) {
      console.error("ntfy publish failed", err);
    }
  }
}

export function appLink(url: string, publicUrl: string): string | null {
  if (!url.startsWith(`${publicUrl}/`)) return null;
  const u = new URL(url);
  const approval = u.searchParams.get("approval");
  if (u.pathname === "/" && approval && /^\d+$/.test(approval))
    return `hatbot://approvals/${approval}`;
  const m = /^\/(tasks|schedules|triggers|boxes)\/(\d+)$/.exec(u.pathname);
  return m ? `hatbot://${m[1]}/${m[2]}` : null;
}

export class LinkingNotifier implements Notifier {
  constructor(
    private inner: Notifier,
    private publicUrl: string,
    private opens: () => "web" | "app",
  ) {}

  send(n: Notification) {
    if (this.opens() !== "app") return this.inner.send(n);
    const link = (url: string) => appLink(url, this.publicUrl) ?? url;
    return this.inner.send({
      ...n,
      click: n.click && link(n.click),
      actions: n.actions?.map((a) => (a.action === "view" ? { ...a, url: link(a.url) } : a)),
    });
  }
}
