// Live input from the owner, in order, without falling behind: of pointer moves still waiting only the
// newest is kept, and wheel turns are added up over WHEEL_MS into one scroll.
import type { LiveInput } from "@hatbot/shared/desktop";

const WHEEL_MS = 100;
type Wheel = Extract<LiveInput, { t: "wheel" }>;

export class LiveQueue {
  private queue: LiveInput[] = [];
  private wheel: Wheel | null = null;
  private wheelTimer: ReturnType<typeof setTimeout> | undefined;
  private running = false;

  constructor(
    private run: (m: LiveInput) => Promise<unknown>,
    private wheelMs = WHEEL_MS,
  ) {}

  push(m: LiveInput) {
    if (m.t === "wheel") {
      if (this.wheel) {
        this.wheel.dx += m.dx;
        this.wheel.dy += m.dy;
        this.wheel.x = m.x;
        this.wheel.y = m.y;
      } else {
        this.wheel = { ...m };
        this.wheelTimer = setTimeout(() => this.flushWheel(), this.wheelMs);
      }
      return;
    }
    // Anything else comes after the scroll it followed.
    this.flushWheel();
    const last = this.queue.at(-1);
    if (m.t === "move" && last?.t === "move") this.queue[this.queue.length - 1] = m;
    else this.queue.push(m);
    void this.drain();
  }

  private flushWheel() {
    clearTimeout(this.wheelTimer);
    if (!this.wheel) return;
    this.queue.push(this.wheel);
    this.wheel = null;
    void this.drain();
  }

  private async drain() {
    if (this.running) return;
    this.running = true;
    try {
      for (let m = this.queue.shift(); m; m = this.queue.shift()) {
        await this.run(m).catch((err) => console.error("live input", err));
      }
    } finally {
      this.running = false;
    }
  }
}
