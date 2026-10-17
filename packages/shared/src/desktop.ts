// The protocol between the brain and desktop-agent (PLAN.md §4.2). Types only: desktop-agent has no dependencies.

/** Members of the computer toolset (computer_toolset_20260801), which desktop-agent runs. */
export const COMPUTER_MEMBERS = [
  "key",
  "hold_key",
  "type",
  "cursor_position",
  "mouse_move",
  "left_mouse_down",
  "left_mouse_up",
  "left_click",
  "left_click_drag",
  "right_click",
  "middle_click",
  "double_click",
  "triple_click",
  "scroll",
  "wait",
  "screenshot",
  "zoom",
] as const;
export type ComputerMember = (typeof COMPUTER_MEMBERS)[number];

/** POST /fetch: a GET from the desktop, which reaches only the internet (watchers). */
export type FetchResult = {
  status: number;
  /** Where it ended up, after redirects. */
  url: string;
  contentType: string;
  /** As text, cut at 2 MB. */
  body: string;
};

/** POST /render: a page after its scripts ran, in a headless Chromium on the desktop (watchers). */
export type RenderResult = {
  /**
   * The page as HTML, cut at 2 MB. Chromium doesn't say the HTTP status, so a site's own error page
   * comes back like any other.
   */
  html: string;
};

/** POST /action. `screenshot` and `zoom` have their own endpoints, which return an image. */
export type AgentAction = {
  name: Exclude<ComputerMember, "screenshot" | "zoom">;
  input: Record<string, unknown>;
};
export type AgentActionResult = { text?: string; x?: number; y?: number };

export type AgentStatus = {
  /** False when a deep check found something down. */
  ok: boolean;
  width: number;
  height: number;
  locked: boolean;
  /** The commit desktop-agent was built from, when deployed. */
  version?: string;
  /** The bot profile Chromium is on; null with the one shared profile (no hatbot-chromium.service). */
  profile?: string | null;
  /** The desktop's time zone, e.g. "Europe/Prague", which pages see. */
  timeZone?: string;
  /** What this copy can do beyond the basics, so the brain knows when it's out of date. */
  features?: string[];
  /** With ?deep=1: whether a frame could be grabbed from the X display. */
  x?: boolean;
  /** With ?deep=1: whether Chromium's DevTools answered. */
  cdp?: boolean;
};

/** GET /context: the visible Chromium tab. `text` only with ?text=1. */
export type AgentContext = {
  url: string | null;
  title: string | null;
  text?: string;
  /** A password, code or card field on the page holds something: a screenshot may show it. */
  secretShown?: boolean;
};

/** POST /inspect: the element under a point, or the focused one, for the click policy (PLAN.md §6.1). */
export type AgentElement = {
  tag: string;
  role: string | null;
  type: string | null;
  label: string;
  inForm: boolean;
  /** For Enter on a form field: the label of the form's submit button. */
  submitLabel?: string;
  /** The focused element takes a password, a one-time code or card details, or can't be seen into (a frame). */
  secret?: boolean;
  /** For the focused element: whether the page has the keyboard, rather than the address bar or another window. */
  pageFocus?: boolean;
  /** The tab's address. With the "fields" feature. */
  url?: string;
  /** It's somewhere to type: a text box, text area or editable region. With the "fields" feature. */
  editable?: boolean;
  /**
   * What the visible text boxes hold, whitespace collapsed, empty ones left out: the form's when the
   * element is in one that has any, otherwise the page's. For the exact-text send check (PLAN.md §16.3).
   * With the "fields" feature.
   */
  fields?: string[];
};

/** POST /exec: a command run by the desktop's shell, which can't see the browser profile or the screen. */
export type ShellResult = { exitCode: number; output: string; timedOut: boolean };

/** Messages the brain sends on the /live socket while the owner has control (PLAN.md §10.5). */
export type LiveInput =
  | { t: "move"; x: number; y: number }
  | { t: "button"; button: 1 | 2 | 3; down: boolean; x: number; y: number }
  | { t: "wheel"; dy: number; dx: number; x: number; y: number }
  | { t: "key"; key: string; down: boolean };

/** A tab as the browser toolset reports it (the API's browser_state tab entry). */
export type BrowserTab = { tab_id: string; url: string; title: string; active?: boolean };

/** Side effects of a browser call: the API's state changes, plus the SDK's dialog kind. */
export type BrowserStateChange =
  | { type: "tab_opened"; tab_id: string }
  | { type: "download_started"; download_id: string; url: string }
  | { type: "download_completed"; download_id: string; url: string; size_bytes?: number }
  | { type: "download_failed"; download_id: string; url: string; error?: string }
  | { type: "dialog_dismissed"; kind: string; message?: string };

/** GET /browser/state: every open tab, one active, and what changed since the last report. */
export type BrowserState = { tabs: BrowserTab[]; state_changes?: BrowserStateChange[] };

/** POST /browser: one browser toolset (browser_toolset_20260801) member, run on Chromium over CDP. */
export type BrowserCall = { name: string; input: Record<string, unknown> };

/** What a browser member returned. The brain hands it to the SDK, which writes the tool result. */
export type BrowserResult =
  | { kind: "none"; text?: string }
  | { kind: "text"; text: string }
  | { kind: "image"; data: string; mediaType: "image/webp" }
  | { kind: "navigate"; url: string; title?: string }
  | { kind: "tab"; tab: BrowserTab }
  | { kind: "tabs"; tabs: BrowserTab[] };

/** POST /browser/inspect: by element reference, at a viewport point, or the focused element. */
export type BrowserInspect = { tab_id?: string; ref?: string; x?: number; y?: number };
