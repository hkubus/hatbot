// The browser toolset (browser_toolset_20260801) on the desktop's Chromium, over its DevTools protocol: one
// browser-level connection, a session per tab, and element references from page.ts. Input goes in through CDP, so
// it reaches the right tab whatever window is on top.
import { join } from "node:path";
import type {
  AgentElement,
  BrowserResult,
  BrowserState,
  BrowserStateChange,
  BrowserTab,
} from "@hatbot/shared/desktop";
import { between, keyGap, type Point, path } from "./human";
import {
  FORM_INPUT,
  INSPECT,
  PAGE_TEXT,
  READ_PAGE,
  RESOLVE_REF,
  SCROLL_TO,
  VIEWPORT,
} from "./page";

const CDP = process.env.HATBOT_CDP ?? "http://127.0.0.1:9222";
const COMMAND_TIMEOUT_MS = 30_000;
const MAX_READ_CHARS = 50_000;

/** A failure the model should read: becomes an error result. */
export class BrowserError extends Error {}

type Json = Record<string, unknown>;
type Pending = {
  method: string;
  resolve: (v: Json) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};
type Listener = (method: string, params: Json, sessionId?: string) => void;
type TargetInfo = { targetId: string; type: string; url: string; title: string };
type Lifecycle = { seq: number; sessionId: string; name: string; loaderId?: string };

/** One WebSocket to the browser endpoint; tab commands carry their session id (flat mode). */
class Connection {
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
      const res = await fetch(`${CDP}/json/version`, { signal: AbortSignal.timeout(3000) });
      url = ((await res.json()) as { webSocketDebuggerUrl: string }).webSocketDebuggerUrl;
    } catch {
      throw new BrowserError("Chromium isn't running, or isn't answering on its DevTools port.");
    }
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new BrowserError("Couldn't connect to Chromium's DevTools port."));
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

// Keys: DOM key names, codes and Windows virtual key codes, as Chromium's input pipeline expects them.
type KeyDef = { key: string; code: string; keyCode: number; text?: string };
const NAMED_KEYS: Record<string, KeyDef> = {
  enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  tab: { key: "Tab", code: "Tab", keyCode: 9 },
  escape: { key: "Escape", code: "Escape", keyCode: 27 },
  backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  delete: { key: "Delete", code: "Delete", keyCode: 46 },
  insert: { key: "Insert", code: "Insert", keyCode: 45 },
  arrowup: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  home: { key: "Home", code: "Home", keyCode: 36 },
  end: { key: "End", code: "End", keyCode: 35 },
  pageup: { key: "PageUp", code: "PageUp", keyCode: 33 },
  pagedown: { key: "PageDown", code: "PageDown", keyCode: 34 },
  space: { key: " ", code: "Space", keyCode: 32, text: " " },
  contextmenu: { key: "ContextMenu", code: "ContextMenu", keyCode: 93 },
  capslock: { key: "CapsLock", code: "CapsLock", keyCode: 20 },
  printscreen: { key: "PrintScreen", code: "PrintScreen", keyCode: 44 },
};
const KEY_ALIASES: Record<string, string> = {
  return: "enter",
  esc: "escape",
  del: "delete",
  up: "arrowup",
  down: "arrowdown",
  left: "arrowleft",
  right: "arrowright",
  page_up: "pageup",
  pgup: "pageup",
  page_down: "pagedown",
  pgdn: "pagedown",
  menu: "contextmenu",
  print: "printscreen",
};
/** Modifier name to its key and its bit in CDP's `modifiers` (Alt 1, Ctrl 2, Meta 4, Shift 8). */
const MODIFIER_KEYS: Record<string, KeyDef & { bit: number }> = {
  alt: { key: "Alt", code: "AltLeft", keyCode: 18, bit: 1 },
  ctrl: { key: "Control", code: "ControlLeft", keyCode: 17, bit: 2 },
  meta: { key: "Meta", code: "MetaLeft", keyCode: 91, bit: 4 },
  shift: { key: "Shift", code: "ShiftLeft", keyCode: 16, bit: 8 },
};
const MODIFIER_ALIASES: Record<string, string> = {
  alt: "alt",
  option: "alt",
  ctrl: "ctrl",
  control: "ctrl",
  meta: "meta",
  super: "meta",
  cmd: "meta",
  command: "meta",
  win: "meta",
  windows: "meta",
  shift: "shift",
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

function keyDef(name: string): KeyDef {
  if ([...name].length === 1) return charKey(name);
  const lower = name.toLowerCase();
  const named = NAMED_KEYS[KEY_ALIASES[lower] ?? lower];
  if (named) return named;
  const f = /^f([1-9]|1\d|2[0-4])$/.exec(lower);
  if (f) return { key: `F${f[1]}`, code: `F${f[1]}`, keyCode: 111 + Number(f[1]) };
  throw new BrowserError(`Unknown key "${name}".`);
}

/** "ctrl+shift+a" to its modifiers and main key. A lone "+" (or a trailing "++") is the plus key. */
function chord(text: string): { mods: (KeyDef & { bit: number })[]; key: KeyDef | null } {
  const t = text.trim();
  if (!t) throw new BrowserError("Empty key name.");
  const parts =
    t === "+" ? ["+"] : t.endsWith("++") ? [...t.slice(0, -2).split("+"), "+"] : t.split("+");
  if (parts.some((p) => !p)) throw new BrowserError(`Can't read the key combination "${text}".`);
  const mods: (KeyDef & { bit: number })[] = [];
  let key: KeyDef | null = null;
  for (const p of parts) {
    const m = MODIFIER_ALIASES[p.toLowerCase()];
    if (m && p.length > 1) mods.push(MODIFIER_KEYS[m] as KeyDef & { bit: number });
    else if (key) throw new BrowserError(`"${text}" names more than one key.`);
    else key = keyDef(p);
  }
  return { mods, key };
}

function modifierBits(text: unknown): number {
  if (typeof text !== "string" || !text.trim()) return 0;
  let bits = 0;
  for (const p of text.split("+")) {
    const m = MODIFIER_ALIASES[p.trim().toLowerCase()];
    if (!m) throw new BrowserError(`"${p}" is not a modifier key (ctrl, shift, alt, meta).`);
    bits |= (MODIFIER_KEYS[m] as { bit: number }).bit;
  }
  return bits;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Page-supplied text that goes into a tab entry: no control characters or line separators, and capped. */
const sanitize = (s: string, n: number) =>
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
  s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").slice(0, n);

type Target = { type: "coordinate"; x: number; y: number } | { type: "ref"; ref: string };
const BUTTONS = { left: 1, right: 2, middle: 4 } as const;

export class Browser {
  private cdp = new Connection();
  private targets = new Map<string, TargetInfo>();
  private tabIds = new Map<string, string>();
  private nextTab = 1;
  private sessions = new Map<string, string>();
  private worlds = new Map<string, { loaderId: string; contextId: number }>();
  /** Per tab, the next element reference: never reused, so a stale ref can't hit a new element. */
  private nextRef = new Map<string, number>();
  private active: string | null = null;
  /** Tabs in the last state report: a tab that's new since then was opened by the last call. */
  private reported = new Set<string>();
  private changes: BrowserStateChange[] = [];
  private downloads = new Map<string, { id: string; url: string }>();
  /** Finished downloads by id: the file's name and where Chromium saved it. */
  private saved = new Map<string, { name: string; path: string }>();
  private names = new Map<string, string>();
  private nextDownload = 1;
  private lifecycle: Lifecycle[] = [];
  private seq = 0;
  private buttons = 0;
  /** Where the pointer last was in each tab, so the next move starts there. */
  private pointers = new Map<string, Point>();

  /** `downloadDir`: where downloads go, named by their guid, so they can be sent on; null leaves Chromium's default. */
  constructor(private downloadDir: string | null = null) {
    this.cdp.on((method, p, sessionId) => this.event(method, p, sessionId));
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

  /** A finished download's file, by the id the model saw. */
  download(id: string): { name: string; path: string } | null {
    return this.saved.get(id) ?? null;
  }

  /** Connects (again) when needed, and learns the open tabs. */
  private async ready() {
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
        return;
      case "Target.targetCreated":
      case "Target.targetInfoChanged": {
        const t = p.targetInfo as TargetInfo;
        this.targets.set(t.targetId, t);
        return;
      }
      case "Target.targetDestroyed": {
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

  /** The active tab follows what's on screen, so it's right after the owner switches tabs during a takeover. */
  private async syncActive() {
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
    if (visible.length === 1) this.active = visible[0] as string;
    else if (!this.active || !this.targets.has(this.active))
      this.active = pages[0]?.targetId ?? null;
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
        const r = await this.cdp.send<{
          result: { value?: T };
          exceptionDetails?: { text?: string; exception?: { description?: string } };
        }>(
          "Runtime.evaluate",
          {
            expression: `(${script})(${JSON.stringify(arg)})`,
            contextId: world.contextId,
            returnByValue: true,
            awaitPromise: true,
          },
          s,
        );
        if (r.exceptionDetails) {
          const why = r.exceptionDetails.exception?.description ?? r.exceptionDetails.text;
          throw new BrowserError(`The page script failed: ${String(why).split("\n")[0]}`);
        }
        return r.result.value as T;
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
    return this.run<{ width: number; height: number; url: string; title: string }>(
      targetId,
      VIEWPORT,
    );
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
      this.buttons |= BUTTONS[button];
      await this.mouse(s, "mousePressed", p, { button, clickCount: i, modifiers });
      await sleep(between(50, 110));
      this.buttons &= ~BUTTONS[button];
      await this.mouse(s, "mouseReleased", p, { button, clickCount: i, modifiers });
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
        const def = charKey(ch);
        await this.cdp.send(
          "Input.dispatchKeyEvent",
          {
            type: "keyDown",
            key: ch,
            code: def.code,
            windowsVirtualKeyCode: def.keyCode,
            text: ch,
            unmodifiedText: ch,
          },
          s,
        );
        await this.cdp.send(
          "Input.dispatchKeyEvent",
          { type: "keyUp", key: ch, code: def.code, windowsVirtualKeyCode: def.keyCode },
          s,
        );
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
      { format: "webp", quality: 90, ...(clip ? { clip } : {}) },
      s,
    );
    return { kind: "image", data, mediaType: "image/webp" };
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
        return this.navigate(tab(), String(input.url ?? ""));
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
        const { scrollX, scrollY } = await this.run<{ scrollX: number; scrollY: number }>(
          t,
          VIEWPORT,
        );
        return this.capture(t, {
          x: x0 + scrollX,
          y: y0 + scrollY,
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
        const down = name === "left_mouse_down";
        await this.moveTo(t, s, p);
        if (down) this.buttons |= 1;
        else this.buttons &= ~1;
        await this.mouse(s, down ? "mousePressed" : "mouseReleased", p, {
          button: "left",
          clickCount: 1,
        });
        return { kind: "none" };
      }
      case "left_click_drag": {
        const t = tab();
        const from = await this.coordinate(t, input.from);
        const to = await this.coordinate(t, input.target);
        const s = await this.session(t);
        await this.moveTo(t, s, from);
        this.buttons |= 1;
        await this.mouse(s, "mousePressed", from, { button: "left", clickCount: 1 });
        await sleep(between(80, 150));
        // Slower while dragging, as a hand is.
        for (const step of path(from, to)) {
          await this.mouse(s, "mouseMoved", step);
          await sleep(between(12, 28));
        }
        this.pointers.set(t, to);
        await sleep(between(60, 120));
        this.buttons &= ~1;
        await this.mouse(s, "mouseReleased", to, { button: "left", clickCount: 1 });
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

  /** The open tabs, and what changed since the last report. */
  async state(): Promise<BrowserState> {
    await this.ready();
    await this.refresh();
    await this.syncActive();
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
    return this.run<AgentElement | null>(this.targetOf(o.tab_id), INSPECT, o).catch(() => null);
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
