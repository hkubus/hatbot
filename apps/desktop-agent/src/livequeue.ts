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
  /** Keys (named ones: a character is typed, not held) and buttons pushed down and not yet up. */
  private held = new Map<string, LiveInput>();
  /** Where the pointer was last sent. */
  private at = { x: 0, y: 0 };

  constructor(
    private run: (m: LiveInput) => Promise<unknown>,
    private wheelMs = WHEEL_MS,
  ) {}

  push(m: LiveInput) {
    const id =
      m.t === "key" && [...m.key].length > 1
        ? `key ${m.key}`
        : m.t === "button"
          ? `button ${m.button}`
          : null;
    if (id && (m.t === "key" || m.t === "button")) {
      if (m.down) this.held.set(id, m);
      else this.held.delete(id);
    }
    if (m.t !== "key") this.at = { x: m.x, y: m.y };
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

  /**
   * Lets go of every key and button still held down, after what's already waiting: a viewer that lost
   * focus or went away mid-press, or control coming back, mustn't leave Ctrl held on the desktop.
   */
  release() {
    const ups = [...this.held.values()].reverse();
    for (const m of ups) {
      if (m.t === "key") this.push({ ...m, down: false });
      else if (m.t === "button") this.push({ ...m, down: false, ...this.at });
    }
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
