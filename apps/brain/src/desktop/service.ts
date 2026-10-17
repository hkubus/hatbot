// Who controls the desktop: Hatbot, or you after Take over (PLAN.md §10.5).
import type { DesktopState } from "@hatbot/shared";
import type { Db } from "../db";
import type { EventBus } from "../events";
import type { DesktopAgent } from "./client";

/** Take over couldn't give the task that asked the screen in time: another task is mid-step. */
export class DesktopBusy extends Error {}

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
  private readying = new Map<number, () => Promise<void>>();

  constructor(
    readonly agent: DesktopAgent,
    private events: EventBus,
    /** Where your control is kept, so a brain restart doesn't hand the desktop back. */
    private db?: Db,
  ) {
    const kept = db
      ?.query<{ value: string }, []>("SELECT value FROM settings WHERE key = 'desktop_control'")
      .get();
    // A request isn't kept: a restart ends the task that asked.
    if (kept?.value === "owner") this.state.control = "owner";
  }

  get(): DesktopState {
    return { ...this.state };
  }

  private set(patch: Partial<DesktopState>) {
    const next = { ...this.state, ...patch };
    if (JSON.stringify(next) === JSON.stringify(this.state)) return;
    if (next.control !== this.state.control)
      this.db
        ?.query(
          "INSERT INTO settings (key, value) VALUES ('desktop_control', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        )
        .run(next.control);
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
   * the screen and its browser profile first, so you work where it needs you (B16).
   */
  async takeover(forRequest = false) {
    const asked = forRequest && this.state.control !== "owner" ? this.state.request : null;
    const ready = asked ? this.readying.get(asked.taskId) : undefined;
    if (ready)
      await ready().catch(() => {
        throw new DesktopBusy("Another task is using the desktop. Try again in a moment.");
      });
    await this.agent.lock();
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
   * While a task waits for you without the screen: `ready` gives it the screen when you take over for it,
   * and rejects when it can't in time. Returns the way to stop.
   */
  onTakeover(taskId: number, ready: () => Promise<void>): () => void {
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
