// Push notifications through your ntfy server (PLAN.md §4.1, Notifier).

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
  /** 1 (min) to 5 (urgent); 3 is the default. */
  priority?: 1 | 2 | 3 | 4 | 5;
  tags?: string[];
  /** Opened when you tap the notification. */
  click?: string;
  actions?: NtfyAction[];
};

export interface Notifier {
  send(n: Notification): Promise<void>;
}

export class NtfyNotifier implements Notifier {
  private url: string;
  private topic: string;
  private token: string;

  constructor(env: Record<string, string | undefined> = process.env) {
    this.url = (env.NTFY_URL ?? "").replace(/\/$/, "");
    this.topic = env.NTFY_TOPIC || "hatbot";
    this.token = env.NTFY_TOKEN ?? "";
  }

  get configured() {
    return Boolean(this.url);
  }

  async send(n: Notification) {
    if (!this.url) return;
    try {
      const res = await fetch(this.url, {
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

/**
 * The web page a notification opens, as the iOS app's link (hatbot://), or null if the app has no
 * such page.
 */
export function appLink(url: string, publicUrl: string): string | null {
  if (!url.startsWith(`${publicUrl}/`)) return null;
  const u = new URL(url);
  const approval = u.searchParams.get("approval");
  if (u.pathname === "/" && approval && /^\d+$/.test(approval))
    return `hatbot://approvals/${approval}`;
  const m = /^\/(tasks|schedules|triggers)\/(\d+)$/.exec(u.pathname);
  return m ? `hatbot://${m[1]}/${m[2]}` : null;
}

/** Points notifications at the iOS app instead of the web app, when Settings say so. */
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
