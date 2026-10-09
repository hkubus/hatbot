// Live events for connected clients (PLAN.md §8, WS events).
export type HatbotEvent =
  | {
      type: "message.created";
      message: {
        id: number;
        role: "user" | "assistant";
        text: string;
        status: string;
        createdAt: string;
      };
    }
  | { type: "message.delta"; id: number; text: string }
  | { type: "message.progress"; id: number; text: string }
  | { type: "message.done"; id: number; text: string; status: "done" | "error" }
  | { type: "spend.updated"; todayUsd: number; monthUsd: number }
  | { type: "memory.committed"; sha: string; message: string; author: string }
  | { type: "paused"; paused: boolean };

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
