// The browser toolset (browser_toolset_20260801) on the desktop's Chromium, over its DevTools protocol: one
// browser-level connection, a session per tab, and element references from page.ts. Input goes in through CDP, so
// it reaches the right tab whatever window is on top.
import { join } from "node:path";
import {
  type AgentElement,
  type BrowserResult,
  type BrowserState,
  type BrowserStateChange,
  type BrowserTab,
  type SessionState,
  sessionHost,
} from "@hatbot/shared/desktop";
import { comboParts } from "@hatbot/shared/keys";
import { between, keyGap, type Point, path } from "./human";
import { keysym, modifier, modifiers } from "./keys";
import {
  FILE_INPUT,
  FORM_INPUT,
  INSPECT,
  PAGE_TEXT,
  READ_PAGE,
  RESOLVE_REF,
  SCROLL_TO,
  VIEWPORT,
} from "./page";
import { webp } from "./x11";

const CDP = process.env.HATBOT_CDP ?? "http://127.0.0.1:9222";
const COMMAND_TIMEOUT_MS = 30_000;
const MAX_READ_CHARS = 50_000;

/** A failure the model should read: becomes an error result. */
export class BrowserError extends Error {}
/** Chromium isn't there to ask: nothing on screen is a page. */
export class ChromiumDown extends BrowserError {}

/** The element script's answer: a frame it couldn't enter is followed here, at a point or its focus. */
type Inspected = AgentElement & { frame?: { x: number; y: number } | { focused: true } };

type Json = Record<string, unknown>;
type Pending = {
  method: string;
  resolve: (v: Json) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};
type Listener = (method: string, params: Json, sessionId?: string) => void;
type TargetInfo = { targetId: string; type: string; url: string; title: string };
type WindowBounds = {
  left?: number;
  top?: number;
  width?: number;
  height?: number;
  windowState?: string;
};
type Lifecycle = { seq: number; sessionId: string; name: string; loaderId?: string };

/** One WebSocket to the browser endpoint; tab commands carry their session id (flat mode). */
class Connection {
  constructor(private endpoint: string) {}

  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private listeners = new Set<Listener>();
  private opening: Promise<boolean> | null = null;

  /** Resolves true when it had to connect (again). */
  ready(): Promise<boolean> {
    if (this.ws?.readyState === WebSocket.OPEN) return Promise.resolve(false);
    this.opening ??= this.open().finally(() => {
      this.opening = null;
    });
    return this.opening;
  }

  private async open(): Promise<boolean> {
    let url: string;
    try {
      const res = await fetch(`${this.endpoint}/json/version`, {
        signal: AbortSignal.timeout(3000),
      });
      url = ((await res.json()) as { webSocketDebuggerUrl: string }).webSocketDebuggerUrl;
    } catch {
      throw new ChromiumDown("Chromium isn't running, or isn't answering on its DevTools port.");
    }
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new ChromiumDown("Couldn't connect to Chromium's DevTools port."));
    });
    ws.onmessage = (e) => this.receive(String(e.data));
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
      for (const [id, p] of this.pending) {
        this.pending.delete(id);
        clearTimeout(p.timer);
        p.reject(new BrowserError(`${p.method} failed: the browser connection closed.`));
      }
      for (const fn of this.listeners) fn("closed", {});
    };
    this.ws = ws;
    return true;
  }

  send<T = Json>(
    method: string,
    params: Json = {},
    sessionId?: string,
    timeoutMs = COMMAND_TIMEOUT_MS,
  ): Promise<T> {
    const ws = this.ws;
    if (!ws) return Promise.reject(new BrowserError("The browser connection is closed."));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BrowserError(`${method} timed out after ${timeoutMs / 1000} s.`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve: resolve as (v: Json) => void, reject, timer });
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  on(fn: Listener) {
    this.listeners.add(fn);
  }

  off(fn: Listener) {
    this.listeners.delete(fn);
  }

  private receive(raw: string) {
    const msg = JSON.parse(raw) as {
      id?: number;
      method?: string;
      params?: Json;
      sessionId?: string;
      result?: Json;
      error?: { message?: string };
    };
    if (msg.id === undefined) {
      if (msg.method)
        for (const fn of this.listeners) fn(msg.method, msg.params ?? {}, msg.sessionId);
      return;
    }
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error)
      p.reject(new BrowserError(`${p.method} failed: ${msg.error.message ?? "unknown error"}`));
    else p.resolve(msg.result ?? {});
  }
}

// Keys: DOM key names, codes and Windows virtual key codes, as Chromium's input pipeline expects them, by
// the X keysym keys.ts reads a name as: the screen and the brain's checks go by the same lists.
type KeyDef = { key: string; code: string; keyCode: number; text?: string };
const ENTER: KeyDef = { key: "Enter", code: "Enter", keyCode: 13, text: "\r" };
const NAMED_KEYS: Record<string, KeyDef> = {
  Return: ENTER,
  KP_Enter: ENTER,
  Tab: { key: "Tab", code: "Tab", keyCode: 9 },
  Escape: { key: "Escape", code: "Escape", keyCode: 27 },
  BackSpace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  Delete: { key: "Delete", code: "Delete", keyCode: 46 },
  Insert: { key: "Insert", code: "Insert", keyCode: 45 },
  Up: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  Down: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  Left: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  Right: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  Home: { key: "Home", code: "Home", keyCode: 36 },
  End: { key: "End", code: "End", keyCode: 35 },
  Page_Up: { key: "PageUp", code: "PageUp", keyCode: 33 },
  Page_Down: { key: "PageDown", code: "PageDown", keyCode: 34 },
  space: { key: " ", code: "Space", keyCode: 32, text: " " },
  Menu: { key: "ContextMenu", code: "ContextMenu", keyCode: 93 },
  Caps_Lock: { key: "CapsLock", code: "CapsLock", keyCode: 20 },
  Print: { key: "PrintScreen", code: "PrintScreen", keyCode: 44 },
};
/** A modifier to its key and its bit in CDP's `modifiers` (Alt 1, Ctrl 2, Meta 4, Shift 8). */
const MODIFIER_KEYS: Record<string, KeyDef & { bit: number }> = {
  alt: { key: "Alt", code: "AltLeft", keyCode: 18, bit: 1 },
  ctrl: { key: "Control", code: "ControlLeft", keyCode: 17, bit: 2 },
  super: { key: "Meta", code: "MetaLeft", keyCode: 91, bit: 4 },
  shift: { key: "Shift", code: "ShiftLeft", keyCode: 16, bit: 8 },
};
// US layout: the unshifted key each symbol is on.
const SYMBOL_KEYS: Record<string, [string, number]> = {
  "-": ["Minus", 189],
  _: ["Minus", 189],
  "=": ["Equal", 187],
  "+": ["Equal", 187],
  "[": ["BracketLeft", 219],
  "{": ["BracketLeft", 219],
  "]": ["BracketRight", 221],
  "}": ["BracketRight", 221],
  "\\": ["Backslash", 220],
  "|": ["Backslash", 220],
  ";": ["Semicolon", 186],
  ":": ["Semicolon", 186],
  "'": ["Quote", 222],
  '"': ["Quote", 222],
  ",": ["Comma", 188],
  "<": ["Comma", 188],
  ".": ["Period", 190],
  ">": ["Period", 190],
  "/": ["Slash", 191],
  "?": ["Slash", 191],
  "`": ["Backquote", 192],
  "~": ["Backquote", 192],
  "!": ["Digit1", 49],
  "@": ["Digit2", 50],
  "#": ["Digit3", 51],
  $: ["Digit4", 52],
  "%": ["Digit5", 53],
  "^": ["Digit6", 54],
  "&": ["Digit7", 55],
  "*": ["Digit8", 56],
  "(": ["Digit9", 57],
  ")": ["Digit0", 48],
};

function charKey(ch: string): KeyDef {
  if (/^[a-z]$/i.test(ch))
    return {
      key: ch,
      code: `Key${ch.toUpperCase()}`,
      keyCode: ch.toUpperCase().charCodeAt(0),
      text: ch,
    };
  if (/^\d$/.test(ch)) return { key: ch, code: `Digit${ch}`, keyCode: 48 + Number(ch), text: ch };
  if (ch === " ") return NAMED_KEYS.space as KeyDef;
  const sym = SYMBOL_KEYS[ch];
  return { key: ch, code: sym?.[0] ?? "", keyCode: sym?.[1] ?? 0, text: ch };
}

/** A key by its name or character; keys.ts refuses one off its lists. */
function keyDef(name: string): KeyDef {
  const sym = keysym(name);
  if ([...name].length === 1) return charKey(name);
  const f = /^F(\d+)$/.exec(sym);
  const def = f ? { key: sym, code: sym, keyCode: 111 + Number(f[1]) } : NAMED_KEYS[sym];
  if (!def) throw new BrowserError(`The browser has no "${name}" key.`);
  return def;
}

/** "ctrl+shift+a" to its modifiers and main key. A lone "+" (or a trailing "++") is the plus key. */
function chord(text: string): { mods: (KeyDef & { bit: number })[]; key: KeyDef | null } {
  const t = text.trim();
  if (!t) throw new BrowserError("Empty key name.");
  const parts = comboParts(t);
  if (parts.some((p) => !p)) throw new BrowserError(`Can't read the key combination "${text}".`);
  const mods: (KeyDef & { bit: number })[] = [];
  let key: KeyDef | null = null;
  for (const p of parts) {
    const m = modifier(p);
    // Modifiers first, as on the screen, where xdotool presses them in order.
    if (m && key)
      throw new BrowserError(
        `"${text}": put the modifiers first and one key last, like ctrl+shift+t.`,
      );
    if (m) mods.push(MODIFIER_KEYS[m] as KeyDef & { bit: number });
    else if (key) throw new BrowserError(`"${text}" names more than one key.`);
    else key = keyDef(p);
  }
  return { mods, key };
}

const modifierBits = (text: unknown) =>
  modifiers(typeof text === "string" ? text : null).reduce(
    (bits, m) => bits | (MODIFIER_KEYS[m]?.bit ?? 0),
    0,
  );

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Page-supplied text that goes into a tab entry: no control characters or line separators, and capped. */
const sanitize = (s: string, n: number) =>
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
  s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").slice(0, n);

type Target = { type: "coordinate"; x: number; y: number } | { type: "ref"; ref: string };
const BUTTONS = { left: 1, right: 2, middle: 4 } as const;

export class Browser {
  private cdp: Connection;
  private targets = new Map<string, TargetInfo>();
  private tabIds = new Map<string, string>();
  private nextTab = 1;
  private sessions = new Map<string, string>();
  private worlds = new Map<string, { loaderId: string; contextId: number }>();
  /** Per tab, the next element reference: never reused, so a stale ref can't hit a new element. */
  private nextRef = new Map<string, number>();
  private active: string | null = null;
  /**
   * Counts the times the tab on screen may have changed; syncActive asks every tab again once this is
   * past what the last finished check started from.
   */
  private touches = 1;
  private checked = 0;
  private checking: Promise<void> | null = null;
  /** The tabs that said they're on screen at the last check: one per window. */
  private shown: string[] = [];
  /** Tabs in the last state report: a tab that's new since then was opened by the last call. */
  private reported = new Set<string>();
  private changes: BrowserStateChange[] = [];
  private downloads = new Map<string, { id: string; url: string }>();
  private saved = new Map<string, { name: string; path: string }>();
  private names = new Map<string, string>();
  private nextDownload = 1;
  private lifecycle: Lifecycle[] = [];
  private seq = 0;
  private buttons = 0;
  /** Where the pointer last was in each tab, so the next move starts there. */
  private pointers = new Map<string, Point>();
  private readying: Promise<void> | null = null;

  /**
   * `downloadDir`: where downloads go, named by their guid, so they can be sent on; null leaves Chromium's
   * default. `endpoint`: its DevTools address, when it isn't $HATBOT_CDP (a test's own Chromium).
   */
  constructor(
    private downloadDir: string | null = null,
    private endpoint = CDP,
  ) {
    this.cdp = new Connection(endpoint);
    this.cdp.on((method, p, sessionId) => this.event(method, p, sessionId));
  }

  async devToolsUp(timeoutMs = 2000): Promise<boolean> {
    try {
      const res = await fetch(`${this.endpoint}/json/version`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Closes Chromium, every window and tab. hatbot-chromium.service opens it again. */
  async quit() {
    try {
      await this.cdp.ready();
      await this.cdp.send("Browser.close", {}, undefined, 5000);
    } catch {
      // Closing drops the connection, sometimes before the answer.
    }
    this.targets.clear();
    this.tabIds.clear();
    this.active = null;
  }

  download(id: string): { name: string; path: string } | null {
    return this.saved.get(id) ?? null;
  }

  /** Connects (again) when needed, and learns the open tabs. Calls at the same time share one attempt. */
  private ready(): Promise<void> {
    this.readying ??= this.connect().finally(() => {
      this.readying = null;
    });
    return this.readying;
  }

  private async connect() {
    if (!(await this.cdp.ready())) return;
    this.targets.clear();
    this.sessions.clear();
    this.worlds.clear();
    const { targetInfos } = await this.cdp.send<{ targetInfos: TargetInfo[] }>("Target.getTargets");
    for (const t of targetInfos) this.targets.set(t.targetId, t);
    await this.cdp.send("Target.setDiscoverTargets", { discover: true });
    await this.cdp
      .send(
        "Browser.setDownloadBehavior",
        this.downloadDir
          ? { behavior: "allowAndName", downloadPath: this.downloadDir, eventsEnabled: true }
          : { behavior: "default", eventsEnabled: true },
      )
      .catch(() => {});
    this.reported = new Set(this.pages().map((t) => t.targetId));
  }

  private event(method: string, p: Json, sessionId?: string) {
    switch (method) {
      case "closed":
        this.sessions.clear();
        this.worlds.clear();
        this.touches++;
        return;
      case "Target.targetCreated":
      case "Target.targetInfoChanged": {
        const t = p.targetInfo as TargetInfo;
        this.targets.set(t.targetId, t);
        // A page can bring a tab it named to the front, and only its info changes.
        if (method === "Target.targetCreated" || t.type === "page") this.touches++;
        return;
      }
      case "Target.targetDestroyed": {
        this.touches++;
        const id = p.targetId as string;
        this.targets.delete(id);
        this.sessions.delete(id);
        this.worlds.delete(id);
        if (this.active === id) this.active = null;
        return;
      }
      case "Target.detachedFromTarget":
        for (const [t, s] of this.sessions) if (s === p.sessionId) this.sessions.delete(t);
        return;
      case "Page.lifecycleEvent":
      case "Page.frameStartedLoading":
        if (!sessionId) return;
        // Only the top frame's: its frame id is the target id.
        if (p.frameId && ![...this.sessions].some(([t, s]) => s === sessionId && t === p.frameId))
          return;
        this.lifecycle.push({
          seq: ++this.seq,
          sessionId,
          name: method === "Page.frameStartedLoading" ? "started" : (p.name as string),
          loaderId: p.loaderId as string | undefined,
        });
        if (this.lifecycle.length > 200) this.lifecycle.splice(0, 100);
        return;
      case "Page.javascriptDialogOpening": {
        if (!sessionId) return;
        // Dismiss it: a dialog blocks the page, and answering one is the owner's call, not the model's.
        // Leaving a page with a beforeunload prompt is allowed, so navigation still works.
        const type = String(p.type ?? "alert");
        void this.cdp
          .send("Page.handleJavaScriptDialog", { accept: type === "beforeunload" }, sessionId)
          .catch(() => {});
        this.changes.push({
          type: "dialog_dismissed",
          kind: type,
          message: sanitize(String(p.message ?? ""), 300),
        });
        return;
      }
      case "Browser.downloadWillBegin": {
        const id = `dl-${this.nextDownload++}`;
        const url = sanitize(String(p.url ?? "").split("?")[0] ?? "", 2000);
        this.downloads.set(p.guid as string, { id, url });
        this.names.set(id, sanitize(String(p.suggestedFilename ?? "download"), 200));
        this.changes.push({ type: "download_started", download_id: id, url });
        return;
      }
      case "Browser.downloadProgress": {
        const d = this.downloads.get(p.guid as string);
        if (!d || p.state === "inProgress") return;
        this.downloads.delete(p.guid as string);
        if (p.state === "completed" && this.downloadDir)
          this.saved.set(d.id, {
            name: this.names.get(d.id) ?? "download",
            path: join(this.downloadDir, p.guid as string),
          });
        this.changes.push(
          p.state === "completed"
            ? {
                type: "download_completed",
                download_id: d.id,
                url: d.url,
                size_bytes: Number(p.totalBytes) || 0,
              }
            : { type: "download_failed", download_id: d.id, url: d.url, error: "canceled" },
        );
        return;
      }
    }
  }

  /** Connected, with titles and URLs fresh and the active tab the one on screen. */
  private async sync() {
    await this.ready();
    await this.refresh();
    await this.syncActive();
  }

  /** Titles and URLs as they are now: the discovery events can lag behind a navigation. */
  private async refresh() {
    const { targetInfos } = await this.cdp.send<{ targetInfos: TargetInfo[] }>("Target.getTargets");
    this.targets = new Map(targetInfos.map((t) => [t.targetId, t]));
  }

  /** Open tabs, oldest first. */
  private pages(): TargetInfo[] {
    const order = (t: TargetInfo) => Number(this.tabId(t.targetId).slice(4));
    return [...this.targets.values()]
      .filter((t) => t.type === "page" && !t.url.startsWith("devtools://"))
      .sort((a, b) => order(a) - order(b));
  }

  private tabId(targetId: string): string {
    let id = this.tabIds.get(targetId);
    if (!id) {
      id = `tab-${this.nextTab++}`;
      this.tabIds.set(targetId, id);
    }
    return id;
  }

  private targetOf(tabId: unknown): string {
    if (tabId === undefined || tabId === null) {
      if (!this.active) throw new BrowserError("No tab is open. Call new_tab first.");
      return this.active;
    }
    for (const [t, id] of this.tabIds) if (id === tabId && this.targets.has(t)) return t;
    throw new BrowserError(`There's no open tab "${String(tabId)}". Call list_tabs to see them.`);
  }

  private entry(t: TargetInfo): BrowserTab {
    return {
      tab_id: this.tabId(t.targetId),
      url: sanitize(t.url, 4096),
      title: sanitize(t.title, 300),
      ...(t.targetId === this.active ? { active: true } : {}),
    };
  }

  /** Input that didn't come through here (the owner's, the computer toolset's) may have switched tabs. */
  screenTouched() {
    this.touches++;
  }

  /**
   * The active tab follows what's on screen, so it's right after the owner switches tabs during a takeover.
   * Every tab is asked only when that may have changed: input from elsewhere, or tabs opening, closing or
   * changing. A caller waits for a check that started after the last such change, not one already
   * under way, which may have asked before the switch.
   */
  private async syncActive() {
    const want = this.touches;
    while (this.checked < want || !this.active || !this.targets.has(this.active)) {
      this.checking ??= this.checkShown();
      await this.checking;
      if (!this.pages().length) return;
    }
  }

  private async checkShown() {
    const from = this.touches;
    try {
      const pages = this.pages();
      const visible: string[] = [];
      await Promise.all(
        pages.map(async (t) => {
          try {
            const s = await this.session(t.targetId);
            const r = await this.cdp.send<{ result: { value?: string } }>(
              "Runtime.evaluate",
              { expression: "document.visibilityState", returnByValue: true },
              s,
              1500,
            );
            if (r.result.value === "visible") visible.push(t.targetId);
          } catch {
            // A tab that's loading, frozen or gone.
          }
        }),
      );
      this.shown = visible;
      // No clear answer (a tab didn't say, or two windows show one each): ask again next time.
      if (visible.length === 1) this.active = visible[0] as string;
      else {
        this.touches++;
        if (!this.active || !this.targets.has(this.active))
          this.active = pages[0]?.targetId ?? null;
      }
    } finally {
      this.checked = Math.max(this.checked, from);
      this.checking = null;
    }
  }

  private async session(targetId: string): Promise<string> {
    const known = this.sessions.get(targetId);
    if (known) return known;
    const { sessionId } = await this.cdp.send<{ sessionId: string }>("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    this.sessions.set(targetId, sessionId);
    await this.cdp.send("Page.enable", {}, sessionId);
    await this.cdp.send("Page.setLifecycleEventsEnabled", { enabled: true }, sessionId);
    return sessionId;
  }

  /** Runs one of page.ts's scripts in Hatbot's isolated world of the tab's current document. */
  private async run<T>(targetId: string, script: string, arg: unknown = {}): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const s = await this.session(targetId);
      const { frameTree } = await this.cdp.send<{
        frameTree: { frame: { id: string; loaderId: string } };
      }>("Page.getFrameTree", {}, s);
      let world = this.worlds.get(targetId);
      if (!world || world.loaderId !== frameTree.frame.loaderId) {
        const { executionContextId } = await this.cdp.send<{ executionContextId: number }>(
          "Page.createIsolatedWorld",
          { frameId: frameTree.frame.id, worldName: "hatbot" },
          s,
        );
        world = { loaderId: frameTree.frame.loaderId, contextId: executionContextId };
        this.worlds.set(targetId, world);
      }
      try {
        return await this.evaluate<T>(s, world.contextId, script, arg);
      } catch (err) {
        // The document changed under us (a navigation): make a new world once.
        if (attempt === 0 && err instanceof BrowserError && /context/i.test(err.message)) {
          this.worlds.delete(targetId);
          continue;
        }
        throw err;
      }
    }
  }

  private async evaluate<T>(session: string, contextId: number, script: string, arg: unknown) {
    const r = await this.cdp.send<{
      result: { value?: T };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    }>(
      "Runtime.evaluate",
      {
        expression: `(${script})(${JSON.stringify(arg)})`,
        contextId,
        returnByValue: true,
        awaitPromise: true,
      },
      session,
    );
    if (r.exceptionDetails) {
      const why = r.exceptionDetails.exception?.description ?? r.exceptionDetails.text;
      throw new BrowserError(`The page script failed: ${String(why).split("\n")[0]}`);
    }
    return r.result.value as T;
  }

  /**
   * Follows the element script into the frames it couldn't enter (another origin's, where a payment or chat
   * widget lives), through Hatbot's world in each frame's own document, and answers with what's inside. A
   * frame it can't get into either stays the answer, so the brain holds what it can't see.
   */
  private async intoFrames(
    targetId: string,
    first: Inspected | null,
  ): Promise<AgentElement | null> {
    if (!first?.frame) return first;
    let el: Inspected = first;
    let session = await this.session(targetId);
    let contextId = this.worlds.get(targetId)?.contextId;
    const attached: string[] = [];
    try {
      for (let depth = 0; el.frame && contextId !== undefined && depth < 4; depth++) {
        const frame = el.frame;
        const { result } = await this.cdp.send<{ result: { objectId?: string } }>(
          "Runtime.evaluate",
          { expression: "globalThis.__hatbotFrame", contextId },
          session,
        );
        if (!result.objectId) break;
        const { node } = await this.cdp.send<{ node: { frameId?: string } }>(
          "DOM.describeNode",
          { objectId: result.objectId },
          session,
        );
        if (!node.frameId) break;
        const world = await this.frameWorld(session, node.frameId, attached);
        const inner = await this.evaluate<Inspected | null>(
          world.session,
          world.contextId,
          INSPECT,
          "focused" in frame ? {} : frame,
        );
        if (!inner) break;
        ({ session, contextId } = world);
        // The tab's address stays the tab's; the frame's is said apart. Whether the page has the keyboard
        // (not the address bar) is the tab's too.
        el = { ...inner, url: first.url, frameUrl: inner.url };
        if (first.pageFocus !== undefined) el.pageFocus = first.pageFocus;
      }
    } catch {
      // What was seen so far stands: at worst the frame itself.
    } finally {
      for (const s of attached)
        void this.cdp.send("Target.detachFromTarget", { sessionId: s }).catch(() => {});
    }
    const { frame: _, ...out } = el;
    // Teach mode counts typing in a frame as secret, whatever's inside.
    return first.secret ? { ...out, secret: true } : out;
  }

  /**
   * Hatbot's world in a frame: through the parent's session for a frame in the same process (another origin
   * of the same site), or through the frame's own target for one of another site, which runs in its own.
   */
  private async frameWorld(session: string, frameId: string, attached: string[]) {
    const world = async (s: string) => {
      const { executionContextId } = await this.cdp.send<{ executionContextId: number }>(
        "Page.createIsolatedWorld",
        { frameId, worldName: "hatbot" },
        s,
      );
      return { session: s, contextId: executionContextId };
    };
    try {
      return await world(session);
    } catch {
      const { sessionId } = await this.cdp.send<{ sessionId: string }>("Target.attachToTarget", {
        targetId: frameId,
        flatten: true,
      });
      attached.push(sessionId);
      return world(sessionId);
    }
  }

  /** Waits for the top frame's DOMContentLoaded (then briefly for load) after event number `since`. */
  private async settle(targetId: string, since: number, timeoutMs: number, strict = false) {
    const s = await this.session(targetId);
    const deadline = Date.now() + timeoutMs;
    const after = (name: string) =>
      this.lifecycle.find((e) => e.seq > since && e.sessionId === s && e.name === name);
    while (!after("DOMContentLoaded")) {
      if (Date.now() > deadline) {
        if (strict)
          throw new BrowserError(
            `The page didn't load within ${timeoutMs / 1000} seconds. It may be unavailable.`,
          );
        return;
      }
      await sleep(50);
    }
    const loadBy = Math.min(deadline, Date.now() + 3000);
    while (!after("load") && Date.now() < loadBy) await sleep(50);
  }

  /** After input: if it started a navigation, wait for the new page. */
  private async afterInput(targetId: string, since: number) {
    await sleep(150);
    const s = this.sessions.get(targetId);
    if (this.lifecycle.some((e) => e.seq > since && e.sessionId === s && e.name === "started"))
      await this.settle(targetId, since, 10_000);
  }

  private async viewport(targetId: string) {
    type Viewport = { width: number; height: number; scrollX: number; scrollY: number };
    return this.run<Viewport & { url: string; title: string }>(targetId, VIEWPORT);
  }

  private async point(targetId: string, target: unknown): Promise<{ x: number; y: number }> {
    const t = target as Target | undefined;
    if (t?.type === "ref") {
      const r = await this.run<{ x: number; y: number; error?: string }>(targetId, RESOLVE_REF, {
        ref: t.ref,
      });
      if (r.error) throw new BrowserError(r.error);
      return r;
    }
    if (t?.type === "coordinate") return this.coordinate(targetId, t);
    throw new BrowserError(
      'target must be {"type": "coordinate", "x", "y"} or {"type": "ref", "ref"}.',
    );
  }

  private async coordinate(targetId: string, t: unknown): Promise<{ x: number; y: number }> {
    const c = t as { type?: string; x?: unknown; y?: unknown } | undefined;
    if (c?.type !== "coordinate" || typeof c.x !== "number" || typeof c.y !== "number")
      throw new BrowserError('This needs a coordinate target: {"type": "coordinate", "x", "y"}.');
    const v = await this.viewport(targetId);
    const x = Math.round(c.x);
    const y = Math.round(c.y);
    if (x < 0 || y < 0 || x >= v.width || y >= v.height)
      throw new BrowserError(`(${x}, ${y}) is outside the ${v.width}x${v.height} viewport.`);
    return { x, y };
  }

  private mouse(s: string, type: string, p: { x: number; y: number }, extra: Json = {}) {
    return this.cdp.send(
      "Input.dispatchMouseEvent",
      { type, ...p, buttons: this.buttons, ...extra },
      s,
    );
  }

  /** Presses or lets go of a mouse button, kept in `buttons` for the moves while it's held. */
  private button(
    s: string,
    p: Point,
    down: boolean,
    button: keyof typeof BUTTONS = "left",
    extra = {},
  ) {
    if (down) this.buttons |= BUTTONS[button];
    else this.buttons &= ~BUTTONS[button];
    const type = down ? "mousePressed" : "mouseReleased";
    return this.mouse(s, type, p, { button, clickCount: 1, ...extra });
  }

  /** Moves the pointer to `p` along a person-like path, from wherever it last was in the tab. */
  private async moveTo(targetId: string, s: string, p: Point, extra: Json = {}) {
    const from = this.pointers.get(targetId) ?? {
      x: between(p.x / 2, p.x * 1.5 + 50),
      y: between(p.y / 2, p.y * 1.5 + 50),
    };
    for (const step of path(from, p)) {
      await this.mouse(s, "mouseMoved", step, extra);
      await sleep(between(6, 16));
    }
    this.pointers.set(targetId, p);
  }

  private async click(
    targetId: string,
    input: Json,
    button: keyof typeof BUTTONS,
    count: number,
  ): Promise<BrowserResult> {
    const p = await this.point(targetId, input.target);
    const modifiers = modifierBits(input.modifiers);
    const s = await this.session(targetId);
    const since = this.seq;
    await this.moveTo(targetId, s, p, { modifiers });
    await sleep(between(40, 120));
    for (let i = 1; i <= count; i++) {
      if (i > 1) await sleep(between(60, 110));
      await this.button(s, p, true, button, { clickCount: i, modifiers });
      await sleep(between(50, 110));
      await this.button(s, p, false, button, { clickCount: i, modifiers });
    }
    await this.afterInput(targetId, since);
    return { kind: "none" };
  }

  private async keyEvent(s: string, def: KeyDef, down: boolean, modifiers: number) {
    const typing = down && def.text !== undefined && !(modifiers & (1 | 2 | 4));
    const text = typing && modifiers & 8 && def.text ? def.text.toUpperCase() : def.text;
    await this.cdp.send(
      "Input.dispatchKeyEvent",
      {
        type: down ? (typing ? "keyDown" : "rawKeyDown") : "keyUp",
        key: modifiers & 8 && def.key.length === 1 ? def.key.toUpperCase() : def.key,
        code: def.code,
        windowsVirtualKeyCode: def.keyCode,
        modifiers,
        ...(typing ? { text, unmodifiedText: def.text } : {}),
      },
      s,
    );
  }

  private async press(s: string, combo: string, holdMs = 0) {
    const { mods, key } = chord(combo);
    let bits = 0;
    for (const m of mods) {
      bits |= m.bit;
      await this.keyEvent(s, m, true, bits);
    }
    if (key) await this.keyEvent(s, key, true, bits);
    if (holdMs) await sleep(holdMs);
    if (key) await this.keyEvent(s, key, false, bits);
    for (const m of mods.reverse()) {
      bits &= ~m.bit;
      await this.keyEvent(s, m, false, bits);
    }
  }

  private async typeText(s: string, text: string) {
    // Long text goes in at once, like a paste; short text key by key at a person's pace, for pages
    // that listen for keystrokes or time them.
    if (text.length > 300 && !text.includes("\n")) {
      await this.cdp.send("Input.insertText", { text }, s);
      return;
    }
    let first = true;
    for (const ch of text) {
      if (!first) await sleep(keyGap());
      first = false;
      if (ch === "\r") continue;
      if (ch === "\n") await this.press(s, "Enter");
      else if (ch === "\t") await this.press(s, "Tab");
      else {
        await this.keyEvent(s, charKey(ch), true, 0);
        await this.keyEvent(s, charKey(ch), false, 0);
      }
    }
  }

  private async capture(targetId: string, clip?: Json): Promise<BrowserResult> {
    if (targetId !== this.active)
      throw new BrowserError(
        `${this.tabId(targetId)} isn't the active tab. Call switch_tab first.`,
      );
    const s = await this.session(targetId);
    const { data } = await this.cdp.send<{ data: string }>(
      "Page.captureScreenshot",
      { format: "png", ...(clip ? { clip } : {}) },
      s,
    );
    const image = await webp(Buffer.from(data, "base64"));
    return { kind: "image", data: Buffer.from(image).toString("base64"), mediaType: "image/webp" };
  }

  private async read(targetId: string, opts: Json) {
    const next = this.nextRef.get(targetId) ?? 1;
    const r = await this.run<{ lines: string[]; next: number; truncated: boolean; error?: string }>(
      targetId,
      READ_PAGE,
      { ...opts, next, maxChars: MAX_READ_CHARS },
    );
    if (r.error) throw new BrowserError(r.error);
    this.nextRef.set(targetId, r.next);
    return r;
  }

  /** Runs one member. Callers serialise calls. */
  async call(name: string, input: Json): Promise<BrowserResult> {
    await this.ready();
    await this.syncActive();
    const tab = () => this.targetOf(input.tab_id);
    switch (name) {
      case "navigate":
        // Not String() of anything else: the brain checked the address as the model gave it.
        if (typeof input.url !== "string") throw new BrowserError("url must be a string.");
        return this.navigate(tab(), input.url);
      case "screenshot":
        return this.capture(tab());
      case "zoom": {
        const t = tab();
        const region = input.region;
        if (
          !Array.isArray(region) ||
          region.length !== 4 ||
          !region.every((n) => typeof n === "number" && Number.isFinite(n))
        )
          throw new BrowserError("region must be [x0, y0, x1, y1] in viewport pixels.");
        const [x0, y0, x1, y1] = region.map(Math.round) as [number, number, number, number];
        const v = await this.viewport(t);
        if (!(x1 > x0 && y1 > y0) || x0 < 0 || y0 < 0 || x1 > v.width || y1 > v.height)
          throw new BrowserError(
            `region must be inside the ${v.width}x${v.height} viewport, with x1 > x0 and y1 > y0.`,
          );
        const scale = Math.min(v.width / (x1 - x0), v.height / (y1 - y0));
        // The clip is in page coordinates: add the scroll offset.
        return this.capture(t, {
          x: x0 + v.scrollX,
          y: y0 + v.scrollY,
          width: x1 - x0,
          height: y1 - y0,
          scale,
        });
      }
      case "left_click":
        return this.click(tab(), input, "left", 1);
      case "right_click":
        return this.click(tab(), input, "right", 1);
      case "middle_click":
        return this.click(tab(), input, "middle", 1);
      case "double_click":
        return this.click(tab(), input, "left", 2);
      case "triple_click":
        return this.click(tab(), input, "left", 3);
      case "hover":
      case "mouse_move": {
        const t = tab();
        const p =
          name === "hover"
            ? await this.point(t, input.target)
            : await this.coordinate(t, input.target);
        await this.moveTo(t, await this.session(t), p);
        await sleep(100);
        return { kind: "none" };
      }
      case "left_mouse_down":
      case "left_mouse_up": {
        const t = tab();
        const p = await this.coordinate(t, input.target);
        const s = await this.session(t);
        await this.moveTo(t, s, p);
        await this.button(s, p, name === "left_mouse_down");
        return { kind: "none" };
      }
      case "left_click_drag": {
        const t = tab();
        const from = await this.coordinate(t, input.from);
        const to = await this.coordinate(t, input.target);
        const s = await this.session(t);
        await this.moveTo(t, s, from);
        await this.button(s, from, true);
        await sleep(between(80, 150));
        // Slower while dragging, as a hand is.
        for (const step of path(from, to)) {
          await this.mouse(s, "mouseMoved", step);
          await sleep(between(12, 28));
        }
        this.pointers.set(t, to);
        await sleep(between(60, 120));
        await this.button(s, to, false);
        return { kind: "none" };
      }
      case "scroll": {
        const t = tab();
        const p = await this.coordinate(t, input.target);
        const amount = Math.min(10, Math.max(1, Math.round(Number(input.scroll_amount ?? 3)) || 3));
        const dir = String(input.scroll_direction);
        const delta = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }[dir];
        if (!delta) throw new BrowserError("scroll_direction must be up, down, left or right.");
        const ws = await this.session(t);
        await this.moveTo(t, ws, p);
        await this.mouse(ws, "mouseWheel", p, {
          deltaX: (delta[0] as number) * amount * 100,
          deltaY: (delta[1] as number) * amount * 100,
        });
        await sleep(250);
        return { kind: "none" };
      }
      case "scroll_to": {
        const ref =
          (input.target as Target | undefined)?.type === "ref"
            ? (input.target as { ref: string }).ref
            : null;
        if (!ref) throw new BrowserError('scroll_to needs a ref target: {"type": "ref", "ref"}.');
        const r = await this.run<{ error?: string }>(tab(), SCROLL_TO, { ref });
        if (r.error) throw new BrowserError(r.error);
        return { kind: "none" };
      }
      case "type": {
        const t = tab();
        if (typeof input.text !== "string") throw new BrowserError("text must be a string.");
        const since = this.seq;
        await this.typeText(await this.session(t), input.text);
        if (input.text.includes("\n")) await this.afterInput(t, since);
        return { kind: "none" };
      }
      case "key": {
        const t = tab();
        if (typeof input.text !== "string") throw new BrowserError("text must be a string.");
        const repeat = Math.min(100, Math.max(1, Math.round(Number(input.repeat ?? 1)) || 1));
        const s = await this.session(t);
        const since = this.seq;
        for (let i = 0; i < repeat; i++)
          for (const combo of input.text.trim().split(/\s+/)) await this.press(s, combo);
        await this.afterInput(t, since);
        return { kind: "none" };
      }
      case "hold_key": {
        const t = tab();
        if (typeof input.text !== "string") throw new BrowserError("text must be a string.");
        const secs = Math.min(30, Math.max(0, Number(input.duration) || 0));
        await this.press(await this.session(t), input.text, secs * 1000);
        return { kind: "none" };
      }
      case "wait": {
        const secs = Number(input.duration);
        if (!(secs >= 0 && secs <= 30)) throw new BrowserError("duration must be 0 to 30 seconds.");
        await sleep(secs * 1000);
        return { kind: "none" };
      }
      case "read_page": {
        const filter =
          input.filter === "interactive" || input.filter === "all" ? input.filter : undefined;
        const depth = Math.max(1, Math.round(Number(input.depth ?? 15)) || 15);
        const ref = typeof input.ref === "string" ? input.ref : undefined;
        const r = await this.read(tab(), { filter, depth, ref });
        let text = r.lines.join("\n");
        if (r.truncated)
          text += `\n[Cut at ${MAX_READ_CHARS} characters. Read less: filter "interactive", a smaller depth, or the ref of a section.]`;
        return { kind: "text", text: text || "(nothing visible)" };
      }
      case "find": {
        const query = String(input.query ?? "").trim();
        if (!query) throw new BrowserError("query must describe the element to find.");
        const r = await this.read(tab(), { find: true, depth: 50 });
        const words = query
          .toLowerCase()
          .split(/[^\p{L}\p{N}]+/u)
          .filter((w) => w.length > 1 && !STOPWORDS.has(w));
        const scored = r.lines
          .map((line) => {
            const l = line.toLowerCase();
            const name = /"(.*?)"/.exec(l)?.[1] ?? "";
            let score = 0;
            for (const w of words) {
              if (name.includes(w)) score += 3;
              else if (l.includes(w)) score += 1;
            }
            if (name && name === query.toLowerCase()) score += 5;
            return { line, score };
          })
          .filter((x) => x.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, 20);
        if (!scored.length)
          return { kind: "text", text: `Nothing on the page matches "${query}". Try read_page.` };
        return { kind: "text", text: scored.map((x) => x.line).join("\n") };
      }
      case "get_page_text": {
        const text = await this.run<string>(tab(), PAGE_TEXT, { maxChars: MAX_READ_CHARS });
        return { kind: "text", text: text || "(the page has no text)" };
      }
      case "form_input": {
        const target = input.target as Target | undefined;
        if (target?.type !== "ref")
          throw new BrowserError('form_input needs a ref target: {"type": "ref", "ref"}.');
        if (!["string", "number", "boolean"].includes(typeof input.value))
          throw new BrowserError("value must be a string, number or boolean.");
        const r = await this.run<{ text?: string; error?: string }>(tab(), FORM_INPUT, {
          ref: target.ref,
          value: input.value,
        });
        if (r.error) throw new BrowserError(r.error);
        return { kind: "none", text: r.text };
      }
      case "new_tab": {
        const { targetId } = await this.cdp.send<{ targetId: string }>("Target.createTarget", {
          url: "about:blank",
        });
        if (!this.targets.has(targetId))
          this.targets.set(targetId, { targetId, type: "page", url: "about:blank", title: "" });
        await this.cdp.send("Target.activateTarget", { targetId });
        this.active = targetId;
        return { kind: "tab", tab: this.entry(this.targets.get(targetId) as TargetInfo) };
      }
      case "list_tabs":
        await this.refresh();
        return { kind: "tabs", tabs: this.pages().map((t) => this.entry(t)) };
      case "switch_tab": {
        const t = this.targetOf(input.tab_id);
        await this.cdp.send("Target.activateTarget", { targetId: t });
        this.active = t;
        await sleep(100);
        return { kind: "tab", tab: this.entry(this.targets.get(t) as TargetInfo) };
      }
      case "close_tab": {
        const t = this.targetOf(input.tab_id);
        await this.cdp.send("Target.closeTarget", { targetId: t });
        this.targets.delete(t);
        if (this.active === t) this.active = null;
        await sleep(200);
        await this.syncActive();
        return { kind: "none" };
      }
      default:
        throw new BrowserError(`${name} isn't available in this browser.`);
    }
  }

  private async navigate(targetId: string, raw: string): Promise<BrowserResult> {
    const s = await this.session(targetId);
    const since = this.seq;
    const where = raw.trim();
    if (where === "back" || where === "forward") {
      const h = await this.cdp.send<{ currentIndex: number; entries: { id: number }[] }>(
        "Page.getNavigationHistory",
        {},
        s,
      );
      const entry = h.entries[h.currentIndex + (where === "back" ? -1 : 1)];
      if (!entry) throw new BrowserError(`There's no page to go ${where} to.`);
      await this.cdp.send("Page.navigateToHistoryEntry", { entryId: entry.id }, s);
      await this.settle(targetId, since, 10_000);
    } else if (where === "reload") {
      await this.cdp.send("Page.reload", {}, s);
      await this.settle(targetId, since, 30_000, true);
    } else {
      const url = /^[a-z][a-z0-9+.-]*:/i.test(where) ? where : `https://${where}`;
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new BrowserError(`"${raw}" isn't a URL.`);
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
        throw new BrowserError("Navigation refused. Only http and https URLs are allowed.");
      const r = await this.cdp.send<{ errorText?: string; loaderId?: string }>(
        "Page.navigate",
        { url: parsed.href },
        s,
      );
      if (r.errorText)
        throw new BrowserError(`Navigation to ${parsed.href} failed: ${r.errorText}.`);
      if (r.loaderId) await this.settle(targetId, since, 30_000, true);
    }
    const v = await this.viewport(targetId);
    return { kind: "navigate", url: sanitize(v.url, 4096), title: sanitize(v.title, 300) };
  }

  /**
   * At a task's start: every tab but the one on screen is closed, and what happened before is forgotten, so
   * tabs don't pile up from task to task.
   */
  async reset(): Promise<{ closed: number }> {
    await this.sync();
    const keep = this.active ?? this.pages()[0]?.targetId;
    let closed = 0;
    for (const t of this.pages()) {
      if (t.targetId === keep) continue;
      await this.cdp.send("Target.closeTarget", { targetId: t.targetId }).catch(() => {});
      this.targets.delete(t.targetId);
      closed++;
    }
    if (keep) await this.cdp.send("Target.activateTarget", { targetId: keep }).catch(() => {});
    this.active = keep ?? null;
    this.changes = [];
    this.reported = new Set(this.pages().map((t) => t.targetId));
    return { closed };
  }

  /**
   * The tab on screen, for the computer toolset's /context and /inspect: its URL and title, and what `script`
   * (one of page.ts's kind, or null for none) returns in Hatbot's isolated world.
   */
  async onScreen<T>(
    script: string | null,
    arg: unknown = {},
  ): Promise<{ url: string; title: string; value: T | undefined } | null> {
    await this.sync();
    const t = this.active ? this.targets.get(this.active) : undefined;
    if (!t) return null;
    const value = script === null ? undefined : await this.run<T>(t.targetId, script, arg);
    return { url: t.url, title: t.title, value };
  }

  /**
   * What `script` returns in every other tab that was on screen at the last look: a popup's window (a
   * sign-in, 3-D Secure) shows beside the active tab's. Null for one that couldn't be asked.
   */
  async alsoShown<T>(script: string, arg: unknown = {}): Promise<(T | null)[]> {
    const others = this.shown.filter((t) => t !== this.active && this.targets.has(t));
    return Promise.all(others.map((t) => this.run<T>(t, script, arg).catch(() => null)));
  }

  async state(): Promise<BrowserState> {
    await this.sync();
    const pages = this.pages();
    const opened: BrowserStateChange[] = pages
      .filter((t) => !this.reported.has(t.targetId))
      .map((t) => ({ type: "tab_opened", tab_id: this.tabId(t.targetId) }));
    this.reported = new Set(pages.map((t) => t.targetId));
    const changes = [...opened, ...this.changes];
    this.changes = [];
    return {
      tabs: pages.map((t) => this.entry(t)),
      ...(changes.length ? { state_changes: changes } : {}),
    };
  }

  /** The element a click or Enter would act on, for the brain's consequential-step check. */
  async inspect(o: {
    tab_id?: string;
    ref?: string;
    x?: number;
    y?: number;
  }): Promise<AgentElement | null> {
    await this.ready();
    await this.syncActive();
    const t = this.targetOf(o.tab_id);
    return this.run<Inspected | null>(t, INSPECT, o)
      .then((el) => this.intoFrames(t, el))
      .catch(() => null);
  }

  /**
   * Signs the running profile in with a login from Scout: its cookies, and each origin's localStorage,
   * written in a background tab whose page is answered here, so the marketplace isn't asked for it.
   * Anything for a site that isn't a marketplace refuses the whole login.
   */
  async signIn(state: SessionState): Promise<{ cookies: number; origins: number }> {
    const cookies = Array.isArray(state?.cookies) ? state.cookies : [];
    const origins = (Array.isArray(state?.origins) ? state.origins : []).filter(
      (o) => o.localStorage?.length,
    );
    if (cookies.length > 500 || origins.length > 50)
      throw new BrowserError("That login is too big.");
    for (const c of cookies)
      if (typeof c.domain !== "string" || !sessionHost(c.domain))
        throw new BrowserError(
          "A login from Scout may only be for OLX, Allegro Lokalnie or Vinted.",
        );
    const pages = origins.map((o) => {
      let u: URL;
      try {
        u = new URL(o.origin);
      } catch {
        throw new BrowserError("A login from Scout has an origin that isn't an address.");
      }
      if (u.protocol !== "https:" || !sessionHost(u.hostname))
        throw new BrowserError(
          "A login from Scout may only be for OLX, Allegro Lokalnie or Vinted.",
        );
      return { origin: u.origin, items: o.localStorage ?? [] };
    });
    await this.ready();
    if (cookies.length)
      await this.cdp.send("Storage.setCookies", {
        cookies: cookies.map((c) => ({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path,
          secure: c.secure,
          httpOnly: c.httpOnly,
          sameSite: c.sameSite,
          ...(typeof c.expires === "number" && c.expires > 0 ? { expires: c.expires } : {}),
        })),
      });
    for (const p of pages) await this.writeStorage(p.origin, p.items);
    return { cookies: cookies.length, origins: pages.length };
  }

  private async writeStorage(origin: string, items: { name: string; value: string }[]) {
    const { targetId } = await this.cdp.send<{ targetId: string }>("Target.createTarget", {
      url: "about:blank",
      background: true,
    });
    let answer: Listener | null = null;
    try {
      const { sessionId: s } = await this.cdp.send<{ sessionId: string }>("Target.attachToTarget", {
        targetId,
        flatten: true,
      });
      answer = (method, p, sessionId) => {
        if (method !== "Fetch.requestPaused" || sessionId !== s) return;
        void this.cdp
          .send(
            "Fetch.fulfillRequest",
            {
              requestId: p.requestId,
              responseCode: 200,
              responseHeaders: [{ name: "Content-Type", value: "text/html" }],
              body: Buffer.from("<!doctype html><title></title>").toString("base64"),
            },
            s,
          )
          .catch(() => {});
      };
      this.cdp.on(answer);
      await this.cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] }, s);
      await this.cdp.send("Page.navigate", { url: `${origin}/` }, s);
      const write = `(() => { if (location.origin !== ${JSON.stringify(origin)}) return false; for (const [k, v] of ${JSON.stringify(items.map((i) => [String(i.name), String(i.value)]))}) localStorage.setItem(k, v); return true; })()`;
      for (let tries = 0; ; tries++) {
        const r = await this.cdp
          .send<{ result: { value?: boolean } }>(
            "Runtime.evaluate",
            { expression: write, returnByValue: true },
            s,
          )
          .catch(() => null);
        if (r?.result.value) return;
        if (tries >= 50) throw new BrowserError(`Couldn't open ${origin} to sign in there.`);
        await Bun.sleep(100);
      }
    } finally {
      if (answer) this.cdp.off(answer);
      await this.cdp.send("Target.closeTarget", { targetId }).catch(() => {});
    }
  }

  /**
   * Puts files on a file input (FILE_INPUT finds it), as choosing them in the file picker would, if
   * `allowed` says yes to the page's address.
   */
  async setFiles(
    o: { tab_id?: string; ref?: string; paths: string[] },
    allowed: (url: string) => boolean,
  ): Promise<BrowserResult> {
    await this.ready();
    await this.syncActive();
    const t = this.targetOf(o.tab_id);
    const found = await this.run<{ multiple?: boolean; url?: string; error?: string }>(
      t,
      FILE_INPUT,
      { ref: o.ref },
    );
    if (found.error) throw new BrowserError(found.error);
    if (!allowed(found.url ?? ""))
      throw new BrowserError("Files go only on a marketplace's add-listing page.");
    if (!found.multiple && o.paths.length > 1)
      throw new BrowserError("This input takes one file at a time: give one photo.");
    const session = await this.session(t);
    const { result } = await this.cdp.send<{ result: { objectId?: string } }>(
      "Runtime.evaluate",
      { expression: "globalThis.__hatbotFile", contextId: this.worlds.get(t)?.contextId },
      session,
    );
    if (!result.objectId) throw new BrowserError("The file input went away. Read the page again.");
    await this.cdp.send(
      "DOM.setFileInputFiles",
      { files: o.paths, objectId: result.objectId },
      session,
    );
    return {
      kind: "text",
      text: `Put ${o.paths.length} file${o.paths.length === 1 ? "" : "s"} on the input.`,
    };
  }

  /**
   * The screen's /inspect: cdp.ts's element script in the tab under the point, or the one with the
   * keyboard, followed into frames.
   */
  async screenElement(
    script: string,
    arg: { x: number; y: number; focused: boolean },
  ): Promise<AgentElement | null> {
    await this.sync();
    const t = await this.screenTab(arg);
    if (!t) return null;
    return this.intoFrames(t, await this.run<Inspected | null>(t, script, arg));
  }

  /**
   * The tab a screen point or the keyboard is in: with one tab on screen, that one. With more (a popup
   * window: on X11 Chromium doesn't track which window covers which, so each window's tab says it's
   * visible), the one whose window holds the point, or whose page has the keyboard. When that's more than
   * one, or a window won't say where it is, it throws: the brain holds a step it can't see.
   */
  private async screenTab(arg: { x: number; y: number; focused: boolean }) {
    const shown = this.shown.filter((t) => this.targets.has(t));
    if (shown.length <= 1) return this.active;
    const unclear = () =>
      new BrowserError(
        arg.focused
          ? "Several browser windows are open, and Hatbot can't tell which has the keyboard."
          : `Browser windows overlap at (${arg.x}, ${arg.y}), and Hatbot can't tell which is on top.`,
      );
    const holding: string[] = [];
    for (const t of shown) {
      if (arg.focused) {
        const has = await this.run<boolean>(t, "() => document.hasFocus()").catch(() => null);
        if (has === null) throw unclear();
        if (has) holding.push(t);
        continue;
      }
      const w = await this.cdp
        .send<{ bounds?: WindowBounds }>("Browser.getWindowForTarget", { targetId: t })
        .catch(() => null);
      const b = w?.bounds;
      if (!b) throw unclear();
      if (b.windowState === "minimized") continue;
      // A maximised window's bounds may be the ones it goes back to: it covers the screen.
      const whole = b.windowState === "maximized" || b.windowState === "fullscreen";
      const { left = 0, top = 0, width = 0, height = 0 } = b;
      if (whole || (arg.x >= left && arg.x < left + width && arg.y >= top && arg.y < top + height))
        holding.push(t);
    }
    // The keyboard in none of them is the address bar or another window: the page says so itself.
    if (arg.focused && !holding.length) return this.active;
    if (holding.length > 1) throw unclear();
    return holding[0] ?? null;
  }
}

const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "to",
  "of",
  "for",
  "on",
  "in",
  "and",
  "or",
  "with",
  "that",
  "this",
]);
