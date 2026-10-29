import { SandboxError as DesktopError, type Sandbox } from "@hatbot/plugin-sdk";
import type {
  AgentAction,
  AgentActionResult,
  AgentContext,
  AgentElement,
  AgentStatus,
  BoxLook,
  BoxLookResult,
  BrowserCall,
  BrowserInspect,
  BrowserResult,
  BrowserState,
  FetchedImage,
  FetchResult,
  RenderResult,
  SetFiles,
  ShellResult,
  SignIn,
} from "@hatbot/shared/desktop";

export { SandboxError as DesktopError } from "@hatbot/plugin-sdk";

export interface DesktopAgent extends Sandbox {
  readonly configured: boolean;
  /** `deep`: also grabs a frame and asks Chromium's DevTools, for Check everything. */
  status(deep?: boolean): Promise<AgentStatus>;
  screenshot(): Promise<Uint8Array>;
  zoom(region: number[]): Promise<Uint8Array>;
  action(a: AgentAction): Promise<AgentActionResult>;
  /** `secrets`: also whether a secret field on the page holds something (secretShown), for Teach. */
  context(withText?: boolean, secrets?: boolean): Promise<AgentContext>;
  inspect(x?: number, y?: number): Promise<AgentElement | null>;
  /** A command in the desktop's shell, which can't see the browser profile or the screen. */
  exec(command: string, timeoutS: number): Promise<ShellResult>;
  /** Puts a file in the shell's home; the path is relative to it, and one that leaves it is refused. */
  putFile(path: string, bytes: Uint8Array): Promise<void>;
  /** A file in the shell's home, by a path relative to it, up to 25 MB. */
  getFile(path: string): Promise<Uint8Array>;
  /** A browser download that finished, by the id the model saw (dl-3). */
  getDownload(id: string): Promise<{ name: string; bytes: Uint8Array }>;
  /** A GET from the desktop, which reaches only the internet. */
  fetch(url: string): Promise<FetchResult>;
  /** A picture, fetched the same way. */
  fetchImage(url: string): Promise<FetchedImage>;
  /** The page after its scripts ran, in a headless Chromium on the desktop that isn't the bots'. */
  render(url: string): Promise<RenderResult>;
  renderCheck(): Promise<void>;
  /** A box's page drawn in the same Chromium, with no network, and the errors it hit (boxes_look). */
  lookAtBox(look: BoxLook): Promise<BoxLookResult>;
  browser(call: BrowserCall): Promise<BrowserResult>;
  browserState(): Promise<BrowserState>;
  browserInspect(at: BrowserInspect): Promise<AgentElement | null>;
  /** Files where the browser can read them, under `stage`, for one task's set_files. */
  stageFiles(stage: string, files: { name: string; bytes: Uint8Array }[]): Promise<void>;
  dropFiles(stage: string): Promise<void>;
  /** Staged files on a file input; desktop-agent refuses any page but an add-listing one. */
  setFiles(o: SetFiles): Promise<BrowserResult>;
  /** Chromium on this bot's own profile. False where the desktop has one shared profile. */
  useProfile(botId: string): Promise<boolean>;
  /** A marketplace login from Scout in that bot's profile. False on an older desktop-agent. */
  signIn(o: SignIn): Promise<boolean>;
  /** Closes the tabs earlier tasks left open, down to one blank tab. False on an older desktop-agent. */
  resetBrowser(): Promise<boolean>;
  lock(): Promise<void>;
  unlock(): Promise<void>;
  liveSocket(): { url: string; headers: Record<string, string> };
  /** The same desktop, its requests ending as soon as `signal` aborts: a task's, once it's cancelled. */
  withSignal?(signal: AbortSignal): DesktopAgent;
}

/**
 * `wait` may take up to 30 s. desktop-agent types the first 200 characters at a person's pace (up to
 * 15 s) and longer text at about 12 ms a character, so the wait grows with the text.
 */
export function actionTimeoutMs(a: AgentAction): number {
  const text = a.name === "type" ? a.input?.text : undefined;
  const chars = typeof text === "string" ? text.length : 0;
  return 45_000 + (chars > 200 ? chars * 25 : 0);
}

/**
 * `wait` and page loads may take up to 30 s. The browser types key by key at a person's pace, about
 * 85 ms a key and now and then 400, so the wait grows with the text.
 */
export function browserTimeoutMs(call: BrowserCall): number {
  const text = call.name === "type" ? call.input?.text : undefined;
  return 45_000 + (typeof text === "string" ? text.length * 150 : 0);
}

const tooOld = (what: string) => (): never => {
  throw new DesktopError(`desktop-agent is too old to ${what}; run Update.`, 404);
};

export class HttpDesktopAgent implements DesktopAgent {
  readonly configured: boolean;

  constructor(
    private baseUrl: string,
    private token: string,
    private signal?: AbortSignal,
  ) {
    this.configured = Boolean(baseUrl && token);
  }

  withSignal(signal: AbortSignal): DesktopAgent {
    return new HttpDesktopAgent(this.baseUrl, this.token, signal);
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
        signal: this.signal
          ? AbortSignal.any([AbortSignal.timeout(timeoutMs), this.signal])
          : AbortSignal.timeout(timeoutMs),
      });
    } catch {
      this.signal?.throwIfAborted();
      throw new DesktopError("The desktop isn't answering.", 0);
    }
    if (!res.ok) {
      const msg = ((await res.json().catch(() => ({}))) as { error?: string }).error;
      throw new DesktopError(msg ?? `desktop-agent returned ${res.status}`, res.status);
    }
    return res;
  }

  private async json<T>(method: string, path: string, body?: unknown, timeoutMs?: number) {
    return (await (await this.req(method, path, body, timeoutMs)).json()) as T;
  }

  private async unlessOld<T>(call: () => Promise<T>, old: () => T): Promise<T> {
    try {
      return await call();
    } catch (err) {
      if (err instanceof DesktopError && err.status === 404) return old();
      throw err;
    }
  }

  status(deep = false) {
    const path = deep ? "/health?deep=1" : "/health";
    return this.json<AgentStatus>("GET", path, undefined, deep ? 15_000 : 3000);
  }
  async screenshot() {
    return (await this.req("POST", "/screenshot")).bytes();
  }
  async zoom(region: number[]) {
    return (await this.req("POST", "/zoom", { region })).bytes();
  }
  action(a: AgentAction) {
    return this.json<AgentActionResult>("POST", "/action", a, actionTimeoutMs(a));
  }
  context(withText = false, secrets = false) {
    const query = [withText && "text=1", secrets && "secrets=1"].filter(Boolean).join("&");
    return this.json<AgentContext>("GET", `/context${query ? `?${query}` : ""}`);
  }
  inspect(x?: number, y?: number) {
    return this.json<AgentElement | null>("POST", "/inspect", { x, y });
  }
  exec(command: string, timeoutS: number) {
    return this.json<ShellResult>("POST", "/exec", { command, timeoutS }, (timeoutS + 15) * 1000);
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
  fetch(url: string) {
    return this.unlessOld(
      () => this.json<FetchResult>("POST", "/fetch", { url }, 30_000),
      tooOld("fetch pages"),
    );
  }
  fetchImage(url: string) {
    return this.unlessOld(
      () => this.json<FetchedImage>("POST", "/fetch/image", { url }, 30_000),
      tooOld("fetch pictures"),
    );
  }
  render(url: string) {
    // The desktop renders one page at a time, so this one may wait behind a few others.
    return this.unlessOld(
      () => this.json<RenderResult>("POST", "/render", { url }, 120_000),
      tooOld("run a page's scripts"),
    );
  }
  async renderCheck() {
    await this.req("POST", "/render/check", {}, 30_000);
  }
  lookAtBox(look: BoxLook) {
    return this.unlessOld(
      () => this.json<BoxLookResult>("POST", "/render/box", look, 120_000),
      tooOld("look at boxes"),
    );
  }
  browser(call: BrowserCall) {
    return this.json<BrowserResult>("POST", "/browser", call, browserTimeoutMs(call));
  }
  browserState() {
    return this.json<BrowserState>("GET", "/browser/state");
  }
  browserInspect(at: BrowserInspect) {
    return this.json<AgentElement | null>("POST", "/browser/inspect", at);
  }
  async stageFiles(stage: string, files: { name: string; bytes: Uint8Array }[]) {
    for (const f of files)
      await this.unlessOld(
        () =>
          this.req(
            "PUT",
            `/uploads?stage=${encodeURIComponent(stage)}&name=${encodeURIComponent(f.name)}`,
            undefined,
            120_000,
            f.bytes,
          ),
        tooOld("upload photos"),
      );
  }
  async dropFiles(stage: string) {
    await this.req("DELETE", `/uploads?stage=${encodeURIComponent(stage)}`);
  }
  setFiles(o: SetFiles) {
    return this.unlessOld(
      () => this.json<BrowserResult>("POST", "/browser/files", o, 45_000),
      tooOld("upload photos"),
    );
  }
  useProfile(botId: string) {
    return this.unlessOld(
      async () => {
        const res = await this.json<{ profile: string | null }>(
          "POST",
          "/browser/profile",
          { id: botId },
          45_000,
        );
        return res.profile !== null;
      },
      // An older desktop-agent: one profile for every bot.
      () => false,
    );
  }
  signIn(o: SignIn) {
    return this.unlessOld(
      async () => {
        await this.req("POST", "/browser/session", o, 45_000);
        return true;
      },
      () => false,
    );
  }
  resetBrowser() {
    return this.unlessOld(
      async () => {
        await this.req("POST", "/browser/reset");
        return true;
      },
      () => false,
    );
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
