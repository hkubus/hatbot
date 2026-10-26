// The protocol between the brain and desktop-agent. Types only: desktop-agent has no dependencies.

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

/**
 * POST /render/box: a box's page as its owner would see it, for box_look, in the same
 * headless Chromium with no network at all.
 */
export type BoxLook = {
  /** The whole page, Hatbox's preview script in it: it reaches nothing outside itself. */
  html: string;
  /** The Content-Security-Policy it's served with: the frame's. */
  csp: string;
  /** The screen in CSS pixels, e.g. 390 × 844 for a phone. */
  width: number;
  height: number;
  dark: boolean;
};

/** An error the page hit: its own, or the browser's about it (a CSP refusal). */
export type BoxLookError = {
  message: string;
  /** In the page as served, from 1. */
  line?: number;
  /** The same message again, this many times in all. */
  count?: number;
};

export type BoxLookResult = {
  /** A PNG of the top of the page, up to MAX_LOOK_HEIGHT tall, as base64. */
  png: string;
  /** The page's whole size in CSS pixels, which may be more than the screen. */
  width: number;
  height: number;
  /** In the order they came, at most MAX_LOOK_ERRORS. */
  errors: BoxLookError[];
};

/** How much of a page box_look's picture shows, in CSS pixels. */
export const MAX_LOOK_HEIGHT = 1800;
export const MAX_LOOK_ERRORS = 20;

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

/** POST /inspect: the element under a point, or the focused one, for the click policy. */
export type AgentElement = {
  tag: string;
  /** Its ARIA role; "clickable" for a div or icon the page made clickable without one. */
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
   * element is in one that has any, otherwise the page's; search boxes left out. For the exact-text send
   * check. With the "fields" feature.
   */
  fields?: string[];
  /** It opens or closes part of the page (aria-expanded, aria-pressed, a menu or a tab). With "gates". */
  toggle?: boolean;
  /** It's a search box, in a search or filter form, or beside search boxes only. With "gates". */
  search?: boolean;
  /**
   * For a text box: the names of the buttons by it in the nearest part of the page that has any, the
   * ones after it first (a chat box's Send, say), "" for one with no name. Enter there may press one.
   * With "gates".
   */
  buttonsAfter?: string[];
  /** It's inside a frame from another address (a payment widget, say), this one. With "gates". */
  frameUrl?: string;
  /** For a link, or something inside one: where it goes, resolved. With "gates". */
  href?: string;
};

/** POST /exec: a command run by the desktop's shell, which can't see the browser profile or the screen. */
export type ShellResult = { exitCode: number; output: string; timedOut: boolean };

/** Messages the brain sends on the /live socket while the owner has control. */
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

/**
 * POST /browser/files: files staged with PUT /uploads put on a file input, in this order. `ref` is the
 * input, or a control holding or labelling it; without one, the page's only file input.
 */
export type SetFiles = { tab_id?: string; ref?: string; stage: string; names: string[] };

/** The marketplaces' add-listing pages, the only ones a file input may be set on. */
export const UPLOAD_PAGES = [
  { channel: "OLX", host: "olx.pl", paths: ["/adding", "/d/adding"] },
  { channel: "Allegro Lokalnie", host: "allegrolokalnie.pl", paths: ["/o/oferty/wystaw"] },
  { channel: "Vinted", host: "vinted.pl", paths: ["/items/new"] },
] as const;

/** The add-listing page `url` is on, if it's one. */
export function uploadPage(url: string | null | undefined): (typeof UPLOAD_PAGES)[number] | null {
  let u: URL;
  try {
    u = new URL(url ?? "");
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  const host = u.hostname.toLowerCase();
  const path = u.pathname.replace(/\/+$/, "");
  return (
    UPLOAD_PAGES.find(
      (p) =>
        (host === p.host || host === `www.${p.host}`) &&
        p.paths.some((x) => path === x || path.startsWith(`${x}/`)),
    ) ?? null
  );
}

/** A cookie in Playwright's storage state, as Scout keeps a marketplace login. */
export type SessionCookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  /** Seconds since the epoch; -1 or none for a session cookie. */
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
};

/** Playwright's storage state: a marketplace login Scout shares. */
export type SessionState = {
  cookies: SessionCookie[];
  origins: { origin: string; localStorage?: { name: string; value: string }[] }[];
};

/** POST /browser/session: a login from Scout, put in `profile`'s browser. */
export type SignIn = { profile: string; state: SessionState };

/** The sites a login from Scout may be for: the marketplaces, and allegro.pl, which signs Allegro Lokalnie in. */
export const SESSION_HOSTS = ["olx.pl", "allegrolokalnie.pl", "allegro.pl", "vinted.pl"] as const;

/** Whether a cookie's domain or an origin's host is one of SESSION_HOSTS or under one. */
export function sessionHost(host: string): boolean {
  // Only a bare hostname: Chromium reads "evil.example/.olx.pl" as evil.example.
  if (!/^\.?[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(host)) return false;
  const h = host.toLowerCase().replace(/^\./, "");
  return SESSION_HOSTS.some((d) => h === d || h.endsWith(`.${d}`));
}
