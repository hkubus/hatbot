// Your computers: the ones that ever connected, kept by machine id, and the sockets of those online.
import {
  type Db,
  type EventsHost,
  PluginError,
  type ScreenAgent,
  ScreenControl,
  ScreenLane,
} from "@hatbot/plugin-sdk";
import type { ComputerInfo } from "@hatbot/shared";
import type { ComputerHello, ComputerMessage, ComputerWindow } from "@hatbot/shared/computer";
import type { AgentAction } from "@hatbot/shared/desktop";
import { ComputerError, Link } from "./link";

/** Why Hatbot can't act on a computer right now. */
export type Blocked = "offline" | "disabled" | "paused" | "locked" | "owner";

export const BLOCKED_TEXT: Record<Blocked, string> = {
  offline: "isn't connected",
  disabled: "doesn't let Hatbot use it",
  paused: "is paused",
  locked: "is locked",
  owner: "is in use by you",
};

type Row = {
  id: string;
  name: string;
  careful: number;
  token_id: number | null;
  last_seen_at: string | null;
};

/** A request that types waits for the typing, about 25 ms a character past the first 200. */
const actionTimeoutMs = (a: AgentAction) => {
  const text = a.name === "type" ? a.input?.text : undefined;
  return 45_000 + (typeof text === "string" && text.length > 200 ? text.length * 25 : 0);
};

const decode = (b64: string) => new Uint8Array(Buffer.from(b64, "base64"));

class Machine {
  link: Link | null = null;
  readonly lane = new ScreenLane();
  readonly control: ScreenControl;
  readonly viewers = new Set<(frame: ArrayBuffer) => void>();
  readonly waiters = new Set<() => void>();
  /** Tasks and chats that may use it, as the owner approved. */
  readonly grants = new Set<string>();

  constructor(
    readonly id: string,
    changed: () => void,
  ) {
    // The owner's control only stops Hatbot's requests: the computer has its own mouse and keyboard.
    const none = async () => {};
    this.control = new ScreenControl({ lock: none, unlock: none }, changed);
  }

  blocked(): Blocked | null {
    const s = this.link?.status;
    if (!s) return "offline";
    if (!s.enabled) return "disabled";
    if (s.paused) return "paused";
    if (s.locked) return "locked";
    if (s.ownerActive) return "owner";
    return null;
  }

  wake() {
    for (const w of [...this.waiters]) w();
  }
}

/** A computer as a desktop task drives it. */
export type ComputerScreen = {
  readonly id: string;
  readonly name: string;
  readonly lane: ScreenLane;
  readonly control: ScreenControl;
  info(): ComputerInfo;
  /** Its requests end when `signal` aborts. */
  agent(signal?: AbortSignal): ScreenAgent;
  blocked(): Blocked | null;
  /** Resolves once nothing but being switched off stands in the way. */
  whenReady(signal: AbortSignal): Promise<void>;
  claim(taskId: number, signal?: AbortSignal): Promise<void>;
  release(taskId: number): Promise<void>;
  /** Null without the "windows" feature, or when it can't say. */
  windows(signal?: AbortSignal): Promise<ComputerWindow[] | null>;
  granted(key: string): boolean;
  grant(key: string): void;
};

export class Computers {
  private machines = new Map<string, Machine>();

  constructor(
    private db: Db,
    private events: EventsHost,
    private clock: () => number,
  ) {}

  private now() {
    return new Date(this.clock()).toISOString();
  }

  private rows(): Row[] {
    return this.db.query<Row, []>("SELECT * FROM computer_machines ORDER BY name, id").all();
  }

  private row(id: string): Row | null {
    return this.db.query<Row, [string]>("SELECT * FROM computer_machines WHERE id = ?").get(id);
  }

  private machine(id: string): Machine {
    let m = this.machines.get(id);
    if (!m) {
      m = new Machine(id, () => this.changed());
      this.machines.set(id, m);
    }
    return m;
  }

  changed() {
    this.events.emit({ type: "computers", computers: this.list() });
  }

  private info(r: Row): ComputerInfo {
    const m = this.machines.get(r.id);
    const s = m?.link?.status;
    const c = m?.control.get();
    return {
      id: r.id,
      name: r.name,
      online: Boolean(m?.link),
      enabled: s?.enabled ?? false,
      paused: s?.paused ?? false,
      locked: s?.locked ?? false,
      ownerActive: s?.ownerActive ?? false,
      careful: Boolean(r.careful),
      control: c?.control ?? "hatbot",
      request: c?.request ?? null,
      activeTaskId: c?.activeTaskId ?? null,
      botId: c?.botId ?? null,
      lastSeenAt: r.last_seen_at,
    };
  }

  list(): ComputerInfo[] {
    return this.rows().map((r) => this.info(r));
  }

  get(id: string): ComputerInfo | null {
    const r = this.row(id);
    return r ? this.info(r) : null;
  }

  /** By id, or by name in any case. */
  find(nameOrId: string): ComputerInfo | null {
    const want = nameOrId.trim().toLowerCase();
    return this.get(nameOrId) ?? this.list().find((c) => c.name.toLowerCase() === want) ?? null;
  }

  /** It names one, or says which there are. */
  named(nameOrId: string): ComputerInfo {
    const c = this.find(nameOrId);
    if (c) return c;
    const names = this.list().map((x) => x.name);
    throw new PluginError(
      names.length
        ? `There's no computer called "${nameOrId}". Yours: ${names.join(", ")}.`
        : "None of your computers has connected yet.",
    );
  }

  connect(
    hello: ComputerHello,
    tokenId: number,
    send: (text: string) => void,
    close: (code: number, reason: string) => void,
  ): Link {
    const known = this.row(hello.machineId);
    if (known)
      this.db
        .query("UPDATE computer_machines SET token_id = ?, last_seen_at = ? WHERE id = ?")
        .run(tokenId, this.now(), hello.machineId);
    else
      this.db
        .query(
          "INSERT INTO computer_machines (id, name, careful, token_id, last_seen_at) VALUES (?, ?, 0, ?, ?)",
        )
        .run(hello.machineId, hello.name.trim().slice(0, 60) || "Computer", tokenId, this.now());
    const m = this.machine(hello.machineId);
    // The same computer again, from a new socket: the old one is stale.
    m.link?.close(4409, "Connected again");
    m.link?.gone();
    const link = new Link(hello, send, close);
    m.link = link;
    if (m.viewers.size) void link.request({ op: "live", on: true }).catch(() => {});
    m.wake();
    this.changed();
    return link;
  }

  receive(link: Link, m: ComputerMessage) {
    if (link.receive(m)) {
      this.machines.get(link.hello.machineId)?.wake();
      this.changed();
    }
  }

  frame(link: Link, frame: ArrayBuffer) {
    const m = this.machines.get(link.hello.machineId);
    if (m?.link !== link) return;
    for (const v of m.viewers) v(frame);
  }

  disconnect(link: Link) {
    link.gone();
    const m = this.machines.get(link.hello.machineId);
    if (m?.link !== link) return;
    m.link = null;
    this.db
      .query("UPDATE computer_machines SET last_seen_at = ? WHERE id = ?")
      .run(this.now(), m.id);
    m.wake();
    this.changed();
  }

  /** Revoking a device token cuts its computers off. */
  linkOf(id: string): Link | null {
    return this.machines.get(id)?.link ?? null;
  }

  private known(id: string): Machine {
    if (!this.row(id)) throw new PluginError("That's gone.", 404);
    return this.machine(id);
  }

  rename(id: string, name: string) {
    this.known(id);
    this.db.query("UPDATE computer_machines SET name = ? WHERE id = ?").run(name, id);
    this.changed();
  }

  setCareful(id: string, careful: boolean) {
    this.known(id);
    this.db.query("UPDATE computer_machines SET careful = ? WHERE id = ?").run(careful ? 1 : 0, id);
    this.changed();
  }

  private online(id: string): Link {
    const link = this.known(id).link;
    if (!link) throw new PluginError("It isn't connected.", 409);
    return link;
  }

  /** The computer itself answers with its status. */
  async pause(id: string, paused: boolean) {
    await this.online(id).request({ op: "pause", paused }, 10_000);
  }

  async turnOff(id: string) {
    await this.online(id).request({ op: "disable" }, 10_000);
  }

  forget(id: string) {
    const m = this.known(id);
    m.link?.close(4410, "Forgotten");
    if (m.link) this.disconnect(m.link);
    this.machines.delete(id);
    this.db.query("DELETE FROM computer_machines WHERE id = ?").run(id);
    this.changed();
  }

  /** A live view's frames until what it returns is called. */
  watch(id: string, viewer: (frame: ArrayBuffer) => void): () => void {
    const m = this.known(id);
    m.viewers.add(viewer);
    if (m.viewers.size === 1) void m.link?.request({ op: "live", on: true }).catch(() => {});
    return () => {
      m.viewers.delete(viewer);
      if (!m.viewers.size) void m.link?.request({ op: "live", on: false }).catch(() => {});
    };
  }

  screens(): ComputerScreen[] {
    return this.rows().map((r) => this.screen(r.id) as ComputerScreen);
  }

  screen(id: string): ComputerScreen | null {
    if (!this.row(id)) return null;
    const m = this.machine(id);
    const self = this;
    const link = () => {
      if (!m.link) throw new ComputerError("It isn't connected.", "offline");
      return m.link;
    };
    return {
      id,
      get name() {
        return self.row(id)?.name ?? id;
      },
      lane: m.lane,
      control: m.control,
      info: () => self.get(id) as ComputerInfo,
      agent: (signal) => ({
        screenshot: async () =>
          decode((await link().request({ op: "screenshot" }, 30_000, signal)).data),
        zoom: async ([x1 = 0, y1 = 0, x2 = 0, y2 = 0]) =>
          decode(
            (
              await link().request(
                { op: "zoom", x: x1, y: y1, width: x2 - x1, height: y2 - y1 },
                30_000,
                signal,
              )
            ).data,
          ),
        action: async (a) =>
          (
            await link().request(
              { op: "action", name: a.name, input: a.input },
              actionTimeoutMs(a),
              signal,
            )
          ).result,
        inspect: async (x, y) =>
          (await link().request({ op: "inspect", x, y }, 15_000, signal)).element,
      }),
      blocked: () => m.blocked(),
      whenReady: (signal) =>
        new Promise<void>((resolve, reject) => {
          const check = () => {
            const b = m.blocked();
            if (b && b !== "disabled") return;
            m.waiters.delete(check);
            signal.removeEventListener("abort", abort);
            resolve();
          };
          const abort = () => {
            m.waiters.delete(check);
            reject(signal.reason);
          };
          if (signal.aborted) return reject(signal.reason);
          signal.addEventListener("abort", abort, { once: true });
          m.waiters.add(check);
          check();
        }),
      claim: async (taskId, signal) => {
        await link().request({ op: "claim", taskId: String(taskId) }, 15_000, signal);
      },
      release: async (taskId) => {
        await m.link?.request({ op: "release", taskId: String(taskId) }, 15_000).catch(() => {});
      },
      windows: async (signal) => {
        const l = m.link;
        if (!l?.hello.features.includes("windows")) return null;
        try {
          return (await l.request({ op: "windows" }, 10_000, signal)).windows;
        } catch {
          return null;
        }
      },
      granted: (key) => m.grants.has(key),
      grant: (key) => {
        m.grants.add(key);
      },
    };
  }

  /** A task's grants end with it. */
  forgetGrants(key: string) {
    for (const m of this.machines.values()) m.grants.delete(key);
  }
}
