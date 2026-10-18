// HTTP client for desktop-agent (PLAN.md §4.2).
import type {
  AgentAction,
  AgentActionResult,
  AgentContext,
  AgentElement,
  AgentStatus,
  BoxLook,
  BoxLookAnswer,
  BoxLookFetch,
  BoxLookLine,
  BoxLookResult,
  BrowserCall,
  BrowserInspect,
  BrowserResult,
  BrowserState,
  FetchResult,
  RenderResult,
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
  /** The page after its scripts ran, in a headless Chromium on the desktop that isn't the bots'. */
  render(url: string): Promise<RenderResult>;
  /** Renders a page of the desktop's own whose script writes its text. Throws when that fails. */
  renderCheck(): Promise<void>;
  /**
   * A box's page drawn in the same Chromium, with no network, and the errors it hit (box_look), once
   * its steps are tried. With `backend`, the page's hatbox.fetch is answered by it, live.
   */
  lookAtBox(
    look: BoxLook,
    backend?: (f: BoxLookFetch) => Promise<BoxLookAnswer["answer"]>,
  ): Promise<BoxLookResult>;
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
  /** Closes the tabs earlier tasks left open, down to one blank tab. False on an older desktop-agent. */
  resetBrowser(): Promise<boolean>;
  lock(): Promise<void>;
  unlock(): Promise<void>;
  /** WebSocket URL and headers for the live view. */
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

/** What a desktop-agent too old for a call says: run Update. */
const tooOld = (what: string) => (): never => {
  throw new DesktopError(`desktop-agent is too old to ${what}; run Update.`, 404);
};

export class HttpDesktopAgent implements DesktopAgent {
  readonly configured: boolean;

  constructor(
    private baseUrl = process.env.DESKTOP_AGENT_URL ?? "",
    private token = process.env.DESKTOP_AGENT_TOKEN ?? "",
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

  /** `call`, or `old` for a desktop-agent too old to answer it (a 404). */
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
  async lookAtBox(look: BoxLook, backend?: (f: BoxLookFetch) => Promise<BoxLookAnswer["answer"]>) {
    const result = await this.unlessOld(
      () =>
        backend
          ? this.relayedLook({ ...look, relay: crypto.randomUUID() }, backend)
          : this.json<BoxLookResult>("POST", "/render/box", look, 120_000),
      tooOld("look at boxes"),
    );
    // An older renderer leaves out what it doesn't know.
    if (!result) return tooOld("let a look reach a box's backend")();
    if (look.steps?.length && !result.steps) return tooOld("try a box's steps")();
    return result;
  }

  /**
   * A look whose page reaches the box's backend: the renderer streams the page's fetches as they come,
   * each answered here on /render/box/answer, then the result.
   */
  private async relayedLook(
    look: BoxLook,
    backend: (f: BoxLookFetch) => Promise<BoxLookAnswer["answer"]>,
  ): Promise<BoxLookResult | null> {
    const res = await this.req("POST", "/render/box", look, 120_000);
    if (!res.headers.get("content-type")?.includes("ndjson")) return null;
    const answer = async (f: BoxLookFetch) => {
      const said = await backend(f).catch(() => ({ error: "Couldn't reach its backend." }));
      const a: BoxLookAnswer = { look: look.relay as string, id: f.id, answer: said };
      // A look that ended meanwhile no longer waits for it.
      await this.req("POST", "/render/box/answer", a, 30_000).catch(() => {});
    };
    const decoder = new TextDecoder();
    let rest = "";
    try {
      for await (const chunk of res.body as ReadableStream<Uint8Array>) {
        const lines = (rest + decoder.decode(chunk, { stream: true })).split("\n");
        rest = lines.pop() ?? "";
        for (const text of lines) {
          if (!text.trim()) continue;
          const line = JSON.parse(text) as BoxLookLine;
          if ("fetch" in line) void answer(line.fetch);
          else if ("result" in line) return line.result;
          else throw new DesktopError(line.error, line.status ?? 502);
        }
      }
    } catch (err) {
      if (err instanceof DesktopError) throw err;
      this.signal?.throwIfAborted();
    }
    throw new DesktopError("The desktop isn't answering.", 0);
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
