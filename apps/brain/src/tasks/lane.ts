// The screen lane: one task on the desktop at a time, first come first served (PLAN.md §5.6).

export class ScreenLane {
  private holder: number | null = null;
  private queue: { taskId: number; grant: () => void }[] = [];

  get holderId() {
    return this.holder;
  }

  /** Waits for the screen. Rejects if `signal` aborts first. */
  acquire(taskId: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(signal.reason);
    if (this.holder === null) {
      this.holder = taskId;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const entry = {
        taskId,
        grant: () => {
          signal.removeEventListener("abort", abort);
          resolve();
        },
      };
      const abort = () => {
        this.queue = this.queue.filter((e) => e !== entry);
        reject(signal.reason);
      };
      signal.addEventListener("abort", abort, { once: true });
      this.queue.push(entry);
    });
  }

  release(taskId: number) {
    if (this.holder !== taskId) return;
    const next = this.queue.shift();
    this.holder = next?.taskId ?? null;
    next?.grant();
  }
}
