import type { AgentAction, AgentContext, AgentElement, AgentStatus } from "@hatbot/shared/desktop";
import { type DesktopAgent, DesktopError } from "../src/desktop/client";

/** A desktop that records what it's asked to do. Set `page` and `element` to shape what the policy sees. */
export class FakeDesktop implements DesktopAgent {
  readonly configured = true;
  actions: AgentAction[] = [];
  screenshots = 0;
  locked = false;
  page: AgentContext = { url: "https://example.com/", title: "Example", text: "Hello" };
  element: AgentElement | null = null;

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
