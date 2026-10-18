// Who controls the desktop: Hatbot, or you after Take over (PLAN.md §10.5).
import type { DesktopState } from "@hatbot/shared";
import type { Db } from "../db";
import type { EventBus } from "../events";
import { getSetting, setSetting } from "../settings";
import type { DesktopAgent } from "./client";

/** Take over couldn't give the task that asked the screen: another task is mid-step, or it ended. */
export class DesktopBusy extends Error {}

/**
 * Gives a waiting task the screen for Take over, rejecting with DesktopBusy when it can't; what it returns
 * gives the screen back if Take over fails.
 */
type Readying = () => Promise<(() => void) | undefined>;

export class Desktop {
  private state: DesktopState = {
    online: false,
    control: "hatbot",
    request: null,
    activeTaskId: null,
    botId: null,
  };
  private paused = false;
  private waiters = new Set<() => void>();
  /** Tasks asking for you, in turn. */
  private requests: { taskId: number; reason: string }[] = [];
  private served: number | null = null;
  private readying = new Map<number, Readying>();
  private taking: Promise<void> | null = null;

  constructor(
    readonly agent: DesktopAgent,
    private events: EventBus,
    /** Where your control is kept, so a brain restart doesn't hand the desktop back. */
    private db?: Db,
  ) {
    // A request isn't kept: a restart ends the task that asked.
    if (db && getSetting(db, "desktop_control") === "owner") this.state.control = "owner";
  }

  get(): DesktopState {
    return { ...this.state };
  }

  private set(patch: Partial<DesktopState>) {
    const next = { ...this.state, ...patch };
    if (JSON.stringify(next) === JSON.stringify(this.state)) return;
    if (next.control !== this.state.control && this.db)
      setSetting(this.db, "desktop_control", next.control);
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

  /** The task using the screen, and its bot. */
  setActiveTask(taskId: number | null, botId: string | null = null) {
    this.set({ activeTaskId: taskId, botId: taskId === null ? null : botId });
  }

  /**
   * You take control. `forRequest`: Take over, answering the first task that asked for you; that task gets
   * the screen and its browser profile first, so you work where it needs you (B16). A second Take over
   * while one is under way (a double tap, another device) is the same one: the task is readied once.
   */
  takeover(forRequest = false): Promise<void> {
    this.taking ??= this.take(forRequest).finally(() => {
      this.taking = null;
    });
    return this.taking;
  }

  private async take(forRequest: boolean) {
    const asked = forRequest && this.state.control !== "owner" ? this.state.request : null;
    const ready = asked ? this.readying.get(asked.taskId) : undefined;
    const undo = ready ? await ready() : undefined;
    try {
      await this.agent.lock();
    } catch (err) {
      // The task would hold the screen waiting for a hand-back that can't come.
      undo?.();
      throw err;
    }
    this.served = asked?.taskId ?? null;
    this.set({ control: "owner" });
  }

  async handback() {
    // Hand back even if desktop-agent is down; refresh() fixes the lock when it returns.
    if (!this.paused)
      await this.agent.unlock().catch((err) => console.error("desktop unlock failed", err));
    // The request you took over for is done; another task's waits on.
    this.requests = this.requests.filter((r) => r.taskId !== this.served);
    this.served = null;
    this.set({ control: "hatbot", request: this.requests[0] ?? null });
    for (const w of this.waiters) w();
    this.waiters.clear();
  }

  /** A task asks for you. Requests wait in turn; the first is the one shown. */
  requestTakeover(taskId: number, reason: string) {
    this.requests = [...this.requests.filter((r) => r.taskId !== taskId), { taskId, reason }];
    this.set({ request: this.requests[0] ?? null });
  }

  clearRequest(taskId: number) {
    this.requests = this.requests.filter((r) => r.taskId !== taskId);
    this.set({ request: this.requests[0] ?? null });
  }

  /**
   * While a task waits for you: `ready` gives it the screen when you take over for it, and rejects when
   * it can't in time; what it returns gives the screen back if Take over then fails. Returns the way to
   * stop.
   */
  onTakeover(taskId: number, ready: Readying): () => void {
    this.readying.set(taskId, ready);
    return () => {
      if (this.readying.get(taskId) === ready) this.readying.delete(taskId);
    };
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
