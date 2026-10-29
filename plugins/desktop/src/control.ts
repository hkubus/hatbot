// Who controls the desktop: Hatbot, or you after Take over.
import { type EventsHost, type PluginStore, ScreenControl } from "@hatbot/plugin-sdk";
import type { DesktopState } from "@hatbot/shared";
import type { DesktopAgent } from "./client";

export { ScreenBusy as DesktopBusy } from "@hatbot/plugin-sdk";

export class Desktop extends ScreenControl {
  constructor(
    readonly agent: DesktopAgent,
    events: EventsHost,
    store?: PluginStore,
  ) {
    super(agent, (state) => events.emit({ type: "desktop.state", state }), store);
  }

  override get(): DesktopState {
    return super.get();
  }

  async refresh() {
    if (!this.agent.configured) return this.set({ online: false });
    try {
      const s = await this.agent.status();
      this.set({ online: true });
      // desktop-agent restarted, or missed a lock or unlock while it was down.
      const shouldLock = this.paused || this.state.control === "owner";
      if (shouldLock && !s.locked) await this.agent.lock();
      if (!shouldLock && s.locked) await this.agent.unlock();
    } catch {
      this.set({ online: false });
    }
  }

  /** Pause all locks the desktop's input for Hatbot; resume unlocks it unless you have control. */
  async setPaused(paused: boolean) {
    this.paused = paused;
    if (!this.agent.configured) return;
    try {
      if (paused) await this.agent.lock();
      else if (this.state.control === "hatbot") await this.agent.unlock();
    } catch (err) {
      console.error("desktop lock/unlock failed", err);
    }
  }
}
