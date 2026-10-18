// Teach-by-showing's record mode (PLAN.md §1): your live-view input as a short log of steps.
import type { LiveInput } from "@hatbot/shared/desktop";

/** One recorded step; `t` is milliseconds since the recording started. */
export type RecStep =
  | { t: number; kind: "move"; x: number; y: number }
  | {
      t: number;
      kind: "button";
      button: 1 | 2 | 3;
      down: boolean;
      x: number;
      y: number;
      screen?: string;
    }
  | { t: number; kind: "wheel"; dx: number; dy: number; x: number; y: number }
  /**
   * `hidden`: a character with a modifier, typed into a field that takes a secret or couldn't be checked;
   * not recorded.
   */
  | { t: number; kind: "key"; key: string; screen?: string; hidden?: "secret" | "unknown" }
  /** Typing. `hidden`: not recorded, because the field takes a secret or couldn't be checked. */
  | { t: number; kind: "text"; text: string; hidden?: "secret" | "unknown"; chars: number }
  | { t: number; kind: "page"; url: string | null; title: string | null };

/** The focused field: whether it takes a secret, and the address of the page it's in. */
export type FieldCheck = { secret: boolean; url?: string | null };

/** What the field check throws when the keyboard isn't on a page: the address bar, another window. */
export class OffPage extends Error {}

export type RecorderHooks = {
  clock: () => number;
  /**
   * The focused field. Throwing, or no answer, counts as a secret; OffPage too, though characters with a
   * modifier there may be shortcuts like ctrl+l.
   */
  secretField: () => Promise<FieldCheck>;
  /**
   * The screen now and the address on it, or null when it may show a secret: a secret field on the page
   * holds something, or the page couldn't say.
   */
  screen: () => Promise<{ bytes: Uint8Array; url?: string | null } | null>;
  /** Keeps a screenshot; its archive path. */
  save: (label: string, bytes: Uint8Array) => Promise<string | null>;
};

/** Long enough for a chore; a recording left running stops growing here. */
export const MAX_STEPS = 3000;
/** Screenshots per recording. */
export const MAX_SCREENS = 200;
/** How often the address on screen is asked for: a new one is seen up to this late, and the asking. */
export const PAGE_POLL_MS = 1500;

// A Map: a key named "constructor" or "__proto__" isn't a modifier.
const MODIFIERS = new Map([
  ["Control", "ctrl"],
  ["Alt", "alt"],
  ["Meta", "super"],
]);

type TextStep = Extract<RecStep, { kind: "text" }>;
type KeyStep = Extract<RecStep, { kind: "key" }>;
/** Characters with a modifier in a row, and how to hide them, by how many, once their field is checked. */
type Combos = { steps: KeyStep[]; hide?: (n: number) => KeyStep["hidden"] };

/** Hides a run as its field check decided, for as many as it has now; a hidden step stays hidden. */
function hideRun(run: Combos) {
  const hidden = run.hide?.(run.steps.length);
  if (hidden) for (const s of run.steps) s.hidden = hidden;
}

/** Typing, or characters with a modifier (a paste), and where it went: what snap() keeps no screenshot of. */
type Typed = {
  hidden: () => boolean;
  checked: Promise<unknown>;
  t: number;
  /** The address it went to, origin and path: the field's own, else the one known on screen then. */
  pages: Set<string>;
  /** Address changes seen before it, a new query too. */
  visit: number;
  /** Its own address is still to come: the next one seen soon after may be where it went. */
  open: boolean;
};

/** An address as a page: origin and path, so a new query or fragment is the same page. */
function pageKey(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return url;
  }
}

/** A key step whose last key is a character: ctrl+a, not ctrl+Tab. */
const charKey = (s: RecStep | undefined): s is KeyStep => {
  if (s?.kind !== "key") return false;
  const last = s.key.endsWith("++") ? "+" : (s.key.split("+").at(-1) ?? "");
  return [...last].length === 1;
};
const hiddenText = (s: RecStep | undefined) => s?.kind === "text" && !!s.hidden && s.chars > 0;

/** Characters typed with a modifier between two hidden runs of typing may be part of what was hidden. */
function hideBetweenHidden(steps: RecStep[]) {
  const acts = steps.filter((s) => s.kind !== "move");
  for (let i = 0; i < acts.length; i++) {
    if (!charKey(acts[i])) continue;
    let j = i;
    while (charKey(acts[j + 1])) j++;
    if (hiddenText(acts[i - 1]) && hiddenText(acts[j + 1]))
      for (let k = i; k <= j; k++) (acts[k] as KeyStep).hidden = "secret";
    i = j;
  }
}

export class Recorder {
  readonly steps: RecStep[] = [];
  private held = new Set<string>();
  private altGraph = false;
  private typing: TextStep | null = null;
  private combos: Combos | null = null;
  /** All typing so far, with its field checks: a screenshot waits for them. */
  private typed: Typed[] = [];
  /** The address on screen, whole and as a page, and how many times it has changed. */
  private url: string | null = null;
  private here: string | null = null;
  private visit = 0;
  private pending: Promise<unknown>[] = [];
  private screens = 0;
  private started: number;

  constructor(private hooks: RecorderHooks) {
    this.started = hooks.clock();
  }

  private now() {
    return this.hooks.clock() - this.started;
  }

  private push(step: RecStep) {
    if (this.steps.length < MAX_STEPS) this.steps.push(step);
  }

  /**
   * Takes a screenshot for `step`, kept only when it can't show a secret: not while a secret field on the
   * page holds something, not on a page where typing turned out hidden (a card number or a code may still
   * be on screen when you click Pay), and not after hidden typing until the address changes.
   */
  private snap(step: { screen?: string }, label: string) {
    if (this.screens >= MAX_SCREENS) return;
    this.screens++;
    const typed = [...this.typed];
    const { here, visit } = this;
    this.pending.push(
      (async () => {
        const shot = await this.hooks.screen();
        await Promise.all(typed.map((r) => r.checked));
        const on = [here, pageKey(shot?.url)];
        const shows = (r: Typed) =>
          r.hidden() && (r.visit === visit || on.some((p) => p !== null && r.pages.has(p)));
        if (!shot || typed.some(shows)) {
          this.screens--;
          return;
        }
        const path = await this.hooks.save(label, shot.bytes);
        if (path) step.screen = path;
      })().catch((err) => console.error("teach screenshot failed", err)),
    );
  }

  /** Ends the typing in progress, so the next character checks the focused field again. */
  private endTyping() {
    this.typing = null;
    this.combos = null;
  }

  /**
   * Checks the focused field for typing that starts now, as the first character arrives, before focus can
   * move on; what's typed waits in memory until it answers, and leaves only through finish().
   */
  private check(
    hidden: () => boolean,
    found: (c: FieldCheck) => void,
    failed: (offPage: boolean) => void,
  ) {
    const typed: Typed = {
      hidden,
      checked: Promise.resolve(),
      t: this.now(),
      pages: new Set(this.here ? [this.here] : []),
      visit: this.visit,
      open: true,
    };
    typed.checked = this.hooks.secretField().then(
      (c) => {
        found(c);
        const page = pageKey(c.url);
        if (page) {
          typed.pages = new Set([page]);
          typed.open = false;
        }
      },
      (err) => {
        const offPage = err instanceof OffPage;
        // Typed off the page, it isn't on it.
        if (offPage) {
          typed.pages.clear();
          typed.open = false;
        }
        failed(offPage);
      },
    );
    this.pending.push(typed.checked);
    this.typed.push(typed);
  }

  private type(ch: string) {
    this.combos = null;
    if (!this.typing) {
      const step: TextStep = { t: this.now(), kind: "text", text: "", chars: 0 };
      this.typing = step;
      this.push(step);
      this.check(
        () => !!step.hidden,
        (c) => {
          if (c.secret) step.hidden = "secret";
        },
        () => {
          step.hidden = "unknown";
        },
      );
    }
    this.typing.text += ch;
    this.typing.chars++;
  }

  /**
   * A character with a modifier: a shortcut, unless the field takes a secret. A modifier stuck down, or
   * one that types characters on a layout this doesn't know, mustn't leave a password in clear: where
   * the field can't be checked, none is kept, and off the page (the address bar, where ctrl+l is a
   * shortcut) one is kept only while it's alone: a run there may be a password typed with Ctrl stuck.
   */
  private combo(step: KeyStep) {
    if (!this.combos) {
      const run: Combos = { steps: [] };
      this.combos = run;
      const decide = (hide: Combos["hide"]) => {
        run.hide = hide;
        hideRun(run);
      };
      this.check(
        () => run.steps.some((s) => s.hidden),
        (c) => decide(() => (c.secret ? "secret" : undefined)),
        (offPage) => decide((n) => (offPage && n === 1 ? undefined : "unknown")),
      );
    }
    this.combos.steps.push(step);
    hideRun(this.combos);
  }

  /** The viewer went away, and desktop-agent let go of what it held: so are the modifiers here. */
  keysUp() {
    this.held.clear();
    this.altGraph = false;
  }

  /**
   * Whether a character key with modifiers held types the character. AltGr does (ą, ł, €), and on Windows
   * it comes as Ctrl and Alt together; so does Option on a Mac (å, ł), which gives a character Alt on
   * other systems doesn't: there, Alt with a letter is a shortcut and the key is the plain letter.
   */
  private typesText(key: string): boolean {
    if (!this.held.size || this.altGraph) return true;
    if (this.held.has("ctrl") && this.held.has("alt")) return true;
    return this.held.size === 1 && this.held.has("alt") && !/^[\x20-\x7e]$/.test(key);
  }

  input(m: LiveInput) {
    const t = this.now();
    const last = this.steps.at(-1);
    switch (m.t) {
      case "move":
        if (last?.kind === "move") Object.assign(last, { t, x: m.x, y: m.y });
        else this.push({ t, kind: "move", x: m.x, y: m.y });
        return;
      case "wheel":
        if (last?.kind === "wheel") Object.assign(last, { dx: last.dx + m.dx, dy: last.dy + m.dy });
        else this.push({ t, kind: "wheel", dx: m.dx, dy: m.dy, x: m.x, y: m.y });
        return;
      case "button": {
        this.endTyping();
        const step: RecStep = { t, kind: "button", button: m.button, down: m.down, x: m.x, y: m.y };
        this.push(step);
        if (m.down) this.snap(step, `${this.steps.length}-click`);
        return;
      }
      case "key": {
        if (m.key === "AltGraph") {
          this.altGraph = m.down;
          return;
        }
        const mod = MODIFIERS.get(m.key);
        if (mod) {
          if (m.down) this.held.add(mod);
          else this.held.delete(mod);
          return;
        }
        // A dead key only shapes the next character.
        if (!m.down || m.key === "Shift" || m.key === "Dead") return;
        const printable = [...m.key].length === 1;
        if (printable && this.typesText(m.key)) return this.type(m.key);
        // A correction while typing edits the text rather than becoming a step.
        if (m.key === "Backspace" && !this.held.size && this.typing?.chars) {
          this.typing.text = [...this.typing.text].slice(0, -1).join("");
          this.typing.chars--;
          return;
        }
        if (printable) this.typing = null;
        else this.endTyping();
        const key = [...this.held, printable ? m.key.toLowerCase() : m.key].join("+");
        const step: KeyStep = { t, kind: "key", key };
        this.push(step);
        if (printable) this.combo(step);
        if (m.key === "Enter") this.snap(step, `${this.steps.length}-enter`);
        return;
      }
    }
  }

  /** The URL and title of the visible tab, recorded when they change. */
  page(url: string | null, title: string | null) {
    const last = this.steps.findLast((s) => s.kind === "page");
    if (last?.kind === "page" && last.url === url && last.title === title) return;
    if (!url && !last) return;
    this.endTyping();
    // A new address, not a new title or a moment none could be read: typing from before is off the
    // screen, unless it was typed on this page (a new query keeps the page). Typing whose own page isn't
    // known yet may have been on a new one, when it came soon before: the poll sees a new page late.
    if (url && url !== this.url) {
      this.url = url;
      this.visit++;
    }
    const page = pageKey(url);
    if (page && page !== this.here) {
      this.here = page;
      for (const r of this.typed) {
        if (!r.open) continue;
        if (this.now() - r.t < 2 * PAGE_POLL_MS) r.pages.add(page);
        r.open = false;
      }
    }
    this.push({ t: this.now(), kind: "page", url, title });
  }

  /** Waits for the field checks and screenshots, then returns the steps with hidden text dropped. */
  async finish(): Promise<RecStep[]> {
    this.endTyping();
    for (let n = 0; n < this.pending.length; ) {
      const batch = this.pending.slice(n);
      n = this.pending.length;
      await Promise.all(batch);
    }
    hideBetweenHidden(this.steps);
    return this.steps
      .filter((s) => !(s.kind === "text" && s.chars === 0))
      .map((s) =>
        s.kind === "text" && s.hidden
          ? { ...s, text: "" }
          : s.kind === "key" && s.hidden
            ? { ...s, key: "" }
            : s,
      );
  }
}

const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
const BUTTON = { 1: "left", 2: "middle", 3: "right" } as const;
const NOT_RECORDED = {
  secret: "in a password or code field (not recorded)",
  unknown: "(not recorded: the field couldn't be checked)",
};

/**
 * The steps as lines for the model. A button press and release in the same spot is a click; moves are
 * kept only when nothing follows at their end point (a hover). Screenshots are numbered as they appear.
 */
export function describeSteps(steps: RecStep[]): { lines: string[]; screens: string[] } {
  const lines: string[] = [];
  const screens: string[] = [];
  const shot = (path?: string) => {
    if (!path) return "";
    screens.push(path);
    return ` [screenshot ${screens.length}]`;
  };
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i] as RecStep;
    const next = steps[i + 1];
    const at = `[${secs(s.t)}]`;
    const xy = (p: { x: number; y: number }) => `(${Math.round(p.x)}, ${Math.round(p.y)})`;
    switch (s.kind) {
      case "move":
        if (next && (next.kind === "button" || next.kind === "wheel")) break;
        lines.push(`${at} pointer rests at ${xy(s)}`);
        break;
      case "button": {
        if (!s.down) {
          lines.push(`${at} ${BUTTON[s.button]} button released at ${xy(s)} (a drag)`);
          break;
        }
        const up = next?.kind === "button" && !next.down && next.button === s.button ? next : null;
        const still = up && Math.hypot(up.x - s.x, up.y - s.y) < 5;
        if (still) i++;
        lines.push(
          `${at} ${still ? `${BUTTON[s.button]} click` : `${BUTTON[s.button]} button pressed`} at ${xy(s)}${shot(s.screen)}`,
        );
        break;
      }
      case "wheel":
        lines.push(
          `${at} scroll ${s.dy ? (s.dy > 0 ? "down" : "up") : s.dx > 0 ? "right" : "left"} at ${xy(s)}`,
        );
        break;
      case "key":
        lines.push(
          s.hidden
            ? `${at} pressed a key with a modifier ${NOT_RECORDED[s.hidden]}`
            : `${at} key ${s.key}${shot(s.screen)}`,
        );
        break;
      case "text":
        lines.push(
          s.hidden
            ? `${at} typed ${s.chars} characters ${NOT_RECORDED[s.hidden]}`
            : `${at} typed ${JSON.stringify(s.text)}`,
        );
        break;
      case "page":
        lines.push(
          `${at} page: ${s.title ? `${JSON.stringify(s.title)} ` : ""}${s.url ?? "(none)"}`,
        );
        break;
    }
  }
  return { lines, screens };
}
