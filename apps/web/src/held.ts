// What the live view has pressed on the desktop and not yet let go of. A view that loses focus or goes
// hidden mid-press never sees the key go up, so it sends the ups itself: Ctrl mustn't stay held down.
import type { LiveInput } from "@hatbot/shared/desktop";

export class Held {
  private down = new Map<string, LiveInput>();
  private at = { x: 0, y: 0 };

  note(m: LiveInput) {
    if (m.t !== "key") this.at = { x: m.x, y: m.y };
    if (m.t !== "key" && m.t !== "button") return;
    const id = m.t === "key" ? `key ${m.key}` : `button ${m.button}`;
    if (m.down) this.down.set(id, m);
    else this.down.delete(id);
  }

  /** The ups for everything still down, the last pressed first. Afterwards nothing is down. */
  ups(): LiveInput[] {
    const ups = [...this.down.values()].reverse().map((m): LiveInput => {
      if (m.t === "button") return { ...m, down: false, ...this.at };
      return { ...m, down: false } as LiveInput;
    });
    this.down.clear();
    return ups;
  }
}
