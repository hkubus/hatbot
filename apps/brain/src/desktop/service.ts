// Who controls the desktop: Hatbot, or you after Take over (PLAN.md §10.5).
import type { DesktopState } from "@hatbot/shared";
import type { EventBus } from "../events";
import type { DesktopAgent } from "./client";

export class Desktop {
  private state: DesktopState = {
    online: false,
    control: "hatbot",
    request: null,
    activeTaskId: null,
  };
  private paused = false;
  private waiters = new Set<() => void>();

  constructor(
    readonly agent: DesktopAgent,
    private events: EventBus,
  ) {}

  get(): DesktopState {
    return { ...this.state };
  }

  private set(patch: Partial<DesktopState>) {
    const next = { ...this.state, ...patch };
    if (JSON.stringify(next) === JSON.stringify(this.state)) return;
    this.state = next;
    this.events.emit({ type: "desktop.state", state: this.get() });
  }

  /** Checks desktop-agent answers; the brain calls it every 30 s. */
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

  setActiveTask(taskId: number | null) {
    this.set({ activeTaskId: taskId });
  }

  async takeover() {
    await this.agent.lock();
    this.set({ control: "owner" });
  }

  async handback() {
    // Hand back even if desktop-agent is down; refresh() fixes the lock when it returns.
    if (!this.paused)
      await this.agent.unlock().catch((err) => console.error("desktop unlock failed", err));
    this.set({ control: "hatbot", request: null });
    for (const w of this.waiters) w();
    this.waiters.clear();
  }

  requestTakeover(taskId: number, reason: string) {
    this.set({ request: { taskId, reason } });
  }

  clearRequest(taskId: number) {
    if (this.state.request?.taskId === taskId) this.set({ request: null });
  }

  /** Resolves once you hand the desktop back. */
  waitForHandback(signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const done = () => {
        signal.removeEventListener("abort", abort);
        resolve();
      };
      const abort = () => {
        this.waiters.delete(done);
        reject(signal.reason);
      };
      if (signal.aborted) return reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      this.waiters.add(done);
    });
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
