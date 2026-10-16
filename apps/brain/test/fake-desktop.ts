import type {
  AgentAction,
  AgentContext,
  AgentElement,
  AgentStatus,
  BrowserCall,
  BrowserInspect,
  BrowserResult,
  BrowserState,
  FetchResult,
  ShellResult,
} from "@hatbot/shared/desktop";
import { type DesktopAgent, DesktopError } from "../src/desktop/client";

/** A desktop that records what it's asked to do. Set `page` and `element` to shape what the policy sees. */
export class FakeDesktop implements DesktopAgent {
  readonly configured = true;
  actions: AgentAction[] = [];
  browserCalls: BrowserCall[] = [];
  inspected: BrowserInspect[] = [];
  screenshots = 0;
  locked = false;
  page: AgentContext = { url: "https://example.com/", title: "Example", text: "Hello" };
  element: AgentElement | null = null;
  /** Called after each action and browser call, e.g. to change `element` as a page would. */
  afterAction: ((name: string, input: Record<string, unknown>) => void) | null = null;
  commands: string[] = [];
  /** The bots whose browser profile was asked for, in order. */
  profiles: string[] = [];
  shell: (command: string) => ShellResult = (c) => ({
    exitCode: 0,
    output: `ran ${c}`,
    timedOut: false,
  });

  async useProfile(botId: string) {
    if (this.profiles.at(-1) !== botId) this.profiles.push(botId);
    return true;
  }
  resets = 0;
  async resetBrowser() {
    this.resets++;
    return true;
  }
  /** More of what /health says: version, profile, time zone, features. */
  health: Partial<AgentStatus> = {};
  async status(): Promise<AgentStatus> {
    return { ok: true, width: 1280, height: 800, locked: this.locked, ...this.health };
  }
  async screenshot() {
    this.screenshots++;
    return new Uint8Array([82, 73, 70, 70, this.screenshots]);
  }
  async zoom() {
    return new Uint8Array([1, 2, 3]);
  }
  async action(a: AgentAction) {
    if (this.locked) throw new DesktopError("The owner has control of the desktop.", 423);
    this.actions.push(a);
    this.afterAction?.(a.name, a.input);
    return a.name === "cursor_position" ? { x: 10, y: 20 } : {};
  }
  async context(withText = false) {
    return withText ? { ...this.page } : { url: this.page.url, title: this.page.title };
  }
  async inspect() {
    return this.element;
  }
  async exec(command: string) {
    if (this.locked) throw new DesktopError("The owner has control of the desktop.", 423);
    this.commands.push(command);
    return this.shell(command);
  }
  /** The shell's files, by path. */
  files = new Map<string, Uint8Array>();
  async putFile(path: string, bytes: Uint8Array) {
    if (this.locked) throw new DesktopError("The owner has control of the desktop.", 423);
    this.files.set(path, bytes);
  }
  async getFile(path: string) {
    const f = this.files.get(path);
    if (!f) throw new DesktopError(`There's no file at ${path}.`, 404);
    return f;
  }
  /** Finished browser downloads, by id. */
  downloads = new Map<string, { name: string; bytes: Uint8Array }>();
  async getDownload(id: string) {
    const d = this.downloads.get(id);
    if (!d) throw new DesktopError("There's no finished download with that id.", 404);
    return d;
  }
  async browser(call: BrowserCall): Promise<BrowserResult> {
    if (this.locked) throw new DesktopError("The owner has control of the desktop.", 423);
    this.browserCalls.push(call);
    this.afterAction?.(call.name, call.input);
    if (call.name === "screenshot") {
      this.screenshots++;
      return { kind: "image", data: "UklGRg==", mediaType: "image/webp" };
    }
    if (call.name === "navigate")
      return { kind: "navigate", url: this.page.url ?? "", title: this.page.title ?? "" };
    if (call.name === "read_page") return { kind: "text", text: '- button "Send" [ref_1]' };
    return { kind: "none" };
  }
  /** Pages by address, for watchers. */
  pages = new Map<string, string | Partial<FetchResult>>();
  fetched: string[] = [];
  async fetch(url: string): Promise<FetchResult> {
    this.fetched.push(url);
    const p = this.pages.get(url);
    if (p === undefined) throw new DesktopError("Couldn't fetch it: no such page", 502);
    const r = typeof p === "string" ? { body: p } : p;
    const body = r.body ?? "";
    return {
      status: 200,
      url,
      contentType: body.trimStart().startsWith("{") ? "application/json" : "text/html",
      ...r,
      body,
    };
  }
  async browserState(): Promise<BrowserState> {
    return {
      tabs: [
        { tab_id: "tab-1", url: this.page.url ?? "", title: this.page.title ?? "", active: true },
      ],
    };
  }
  async browserInspect(at: BrowserInspect) {
    this.inspected.push(at);
    return this.element;
  }
  async lock() {
    this.locked = true;
  }
  async unlock() {
    this.locked = false;
  }
  liveSocket() {
    return { url: "ws://127.0.0.1:1/live", headers: {} };
  }
}
