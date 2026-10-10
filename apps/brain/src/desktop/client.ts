// HTTP client for desktop-agent (PLAN.md §4.2).
import type {
  AgentAction,
  AgentActionResult,
  AgentContext,
  AgentElement,
  AgentStatus,
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

  private async req(method: string, path: string, body?: unknown, timeoutMs = 20_000) {
    if (!this.configured)
      throw new DesktopError("The desktop isn't set up (no DESKTOP_AGENT_URL).", 0);
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
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
