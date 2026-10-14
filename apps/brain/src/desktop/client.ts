// HTTP client for desktop-agent (PLAN.md §4.2).
import type {
  AgentAction,
  AgentActionResult,
  AgentContext,
  AgentElement,
  AgentStatus,
  BrowserCall,
  BrowserInspect,
  BrowserResult,
  BrowserState,
  ShellResult,
} from "@hatbot/shared/desktop";

export class DesktopError extends Error {
  constructor(
    message: string,
    /** 400: the action was invalid (tell the model). 423: the owner has control. 0: unreachable. */
    readonly status: number,
  ) {
    super(message);
  }
}

/** What the brain needs from the desktop; tests substitute a fake. */
export interface DesktopAgent {
  readonly configured: boolean;
  status(): Promise<AgentStatus>;
  screenshot(): Promise<Uint8Array>;
  zoom(region: number[]): Promise<Uint8Array>;
  action(a: AgentAction): Promise<AgentActionResult>;
  context(withText?: boolean): Promise<AgentContext>;
  inspect(x?: number, y?: number): Promise<AgentElement | null>;
  /** A command in the desktop's shell, which can't see the browser profile or the screen. */
  exec(command: string, timeoutS: number): Promise<ShellResult>;
  /** Puts a file in the shell's home (a relative path) or anywhere it may write. */
  putFile(path: string, bytes: Uint8Array): Promise<void>;
  /** A file the shell can read, up to 25 MB. */
  getFile(path: string): Promise<Uint8Array>;
  /** A browser download that finished, by the id the model saw (dl-3). */
  getDownload(id: string): Promise<{ name: string; bytes: Uint8Array }>;
  /** One browser toolset member, run on Chromium over CDP. */
  browser(call: BrowserCall): Promise<BrowserResult>;
  browserState(): Promise<BrowserState>;
  /** The element a browser click or Enter would act on. */
  browserInspect(at: BrowserInspect): Promise<AgentElement | null>;
  /**
   * Chromium on this bot's own profile (PLAN.md §14), closing it if it's on another's. False where the
   * desktop has the one shared profile.
   */
  useProfile(botId: string): Promise<boolean>;
  lock(): Promise<void>;
  unlock(): Promise<void>;
  /** WebSocket URL and headers for the live view. */
  liveSocket(): { url: string; headers: Record<string, string> };
}

export class HttpDesktopAgent implements DesktopAgent {
  readonly configured: boolean;

  constructor(
    private baseUrl = process.env.DESKTOP_AGENT_URL ?? "",
    private token = process.env.DESKTOP_AGENT_TOKEN ?? "",
  ) {
    this.configured = Boolean(baseUrl && token);
  }

  private async req(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs = 20_000,
    raw?: Uint8Array,
  ) {
    if (!this.configured)
      throw new DesktopError("The desktop isn't set up (no DESKTOP_AGENT_URL).", 0);
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          "content-type": raw ? "application/octet-stream" : "application/json",
        },
        body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new DesktopError("The desktop isn't answering.", 0);
    }
    if (!res.ok) {
      const msg = ((await res.json().catch(() => ({}))) as { error?: string }).error;
      throw new DesktopError(msg ?? `desktop-agent returned ${res.status}`, res.status);
    }
    return res;
  }

  async status() {
    return (await (await this.req("GET", "/health", undefined, 3000)).json()) as AgentStatus;
  }
  async screenshot() {
    return (await this.req("POST", "/screenshot")).bytes();
  }
  async zoom(region: number[]) {
    return (await this.req("POST", "/zoom", { region })).bytes();
  }
  async action(a: AgentAction) {
    // `wait` may take up to 30 s.
    return (await (await this.req("POST", "/action", a, 45_000)).json()) as AgentActionResult;
  }
  async context(withText = false) {
    return (await (
      await this.req("GET", `/context${withText ? "?text=1" : ""}`)
    ).json()) as AgentContext;
  }
  async inspect(x?: number, y?: number) {
    return (await (await this.req("POST", "/inspect", { x, y })).json()) as AgentElement | null;
  }
  async exec(command: string, timeoutS: number) {
    return (await (
      await this.req("POST", "/exec", { command, timeoutS }, (timeoutS + 15) * 1000)
    ).json()) as ShellResult;
  }
  async putFile(path: string, bytes: Uint8Array) {
    await this.req("PUT", `/files?path=${encodeURIComponent(path)}`, undefined, 120_000, bytes);
  }
  async getFile(path: string) {
    return (
      await this.req("GET", `/files?path=${encodeURIComponent(path)}`, undefined, 120_000)
    ).bytes();
  }
  async getDownload(id: string) {
    const res = await this.req("GET", `/download?id=${encodeURIComponent(id)}`, undefined, 120_000);
    return {
      name: decodeURIComponent(res.headers.get("x-filename") ?? "download"),
      bytes: await res.bytes(),
    };
  }
  async browser(call: BrowserCall) {
    // `wait` and page loads may take up to 30 s.
    return (await (await this.req("POST", "/browser", call, 45_000)).json()) as BrowserResult;
  }
  async browserState() {
    return (await (await this.req("GET", "/browser/state")).json()) as BrowserState;
  }
  async browserInspect(at: BrowserInspect) {
    return (await (await this.req("POST", "/browser/inspect", at)).json()) as AgentElement | null;
  }
  async useProfile(botId: string) {
    try {
      const res = await this.req("POST", "/browser/profile", { id: botId }, 45_000);
      return ((await res.json()) as { profile: string | null }).profile !== null;
    } catch (err) {
      // An older desktop-agent: one profile for every bot.
      if (err instanceof DesktopError && err.status === 404) return false;
      throw err;
    }
  }
  async lock() {
    await this.req("POST", "/lock");
  }
  async unlock() {
    await this.req("POST", "/unlock");
  }
  liveSocket() {
    return {
      url: `${this.baseUrl.replace(/^http/, "ws")}/live`,
      headers: { authorization: `Bearer ${this.token}` },
    };
  }
}
