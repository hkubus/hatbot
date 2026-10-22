import type { HatbotEvent } from "@hatbot/shared";

export type { HatbotEvent };

type Listener = (e: HatbotEvent) => void;

export class EventBus {
  private listeners = new Set<Listener>();

  on(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(e: HatbotEvent) {
    for (const fn of this.listeners) {
      try {
        fn(e);
      } catch (err) {
        console.error("event listener failed", err);
      }
    }
  }
}
