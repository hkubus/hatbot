import type {
  AgentAction,
  AgentContext,
  AgentElement,
  AgentStatus,
  BrowserCall,
  BrowserInspect,
  BrowserResult,
  BrowserState,
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
  commands: string[] = [];
  shell: (command: string) => ShellResult = (c) => ({
    exitCode: 0,
    output: `ran ${c}`,
    timedOut: false,
  });

  async status(): Promise<AgentStatus> {
    return { ok: true, width: 1280, height: 800, locked: this.locked };
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
    if (call.name === "screenshot") {
      this.screenshots++;
      return { kind: "image", data: "UklGRg==", mediaType: "image/webp" };
    }
    if (call.name === "navigate")
      return { kind: "navigate", url: this.page.url ?? "", title: this.page.title ?? "" };
    if (call.name === "read_page") return { kind: "text", text: '- button "Send" [ref_1]' };
    return { kind: "none" };
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
