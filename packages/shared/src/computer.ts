// The protocol between the brain and the Linux app's agent on the owner's own computer. Types only:
// the agent is Rust and mirrors them by hand.
//
// The agent dials out: a WebSocket to /api/v1/computer/connect, with the Linux app's device token as
// `Authorization: Bearer …`. Text frames are JSON ComputerMessage; binary frames are live JPEG frames.
// The brain asks, the agent answers with the same id. Only the agent turns use of the computer on.

import type {
  AgentActionResult,
  AgentElement,
  ComputerMember,
  LiveInput,
  ShellResult,
} from "./desktop";

export const COMPUTER_PROTOCOL = 1;

/** The agent's first message on a new socket. */
export type ComputerHello = {
  t: "hello";
  protocol: number;
  /** Stable per machine (from /etc/machine-id, hashed), so a computer keeps its settings. */
  machineId: string;
  /** Its host name, as the owner sees it until they rename it. */
  name: string;
  version: string;
  /** "niri", "sway", "hyprland" or another wlroots compositor's name. */
  compositor: string;
  /** "Let Hatbot use this computer", switched only at the computer. Off: the brain may not ask anything but status. */
  enabled: boolean;
  /** What this copy can do: "screen", "input", "windows", "atspi", "files", "shell", "live". */
  features: string[];
};

/** The focused monitor, chosen when a task takes the screen and kept for it. In logical pixels. */
export type ComputerScreen = { output: string; width: number; height: number; scale: number };

export type ComputerStatus = {
  enabled: boolean;
  /** The session is locked: nothing can be done until the owner unlocks it. */
  locked: boolean;
  /** The owner used the mouse or keyboard in the last few seconds. */
  ownerActive: boolean;
  /** Use paused from the Linux app's tray, the web or iOS. */
  paused: boolean;
  screen: ComputerScreen | null;
};

/** A window niri knows about. Absent on compositors without the "windows" feature. */
export type ComputerWindow = {
  id: number;
  title: string;
  appId: string;
  focused: boolean;
  /** Where it is on the task's screen, when it's on it. */
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  /** Blacked out from capture by a niri rule: never typed into. */
  hidden?: boolean;
};

/** What the brain asks. Coordinates are in the screenshot's pixels, as on the guest. */
export type ComputerRequest =
  | { op: "status" }
  /** Take the focused monitor for a task, or let it go. */
  | { op: "claim"; taskId: string }
  | { op: "release"; taskId: string }
  | { op: "screenshot" }
  | { op: "zoom"; x: number; y: number; width: number; height: number }
  | {
      op: "action";
      name: Exclude<ComputerMember, "screenshot" | "zoom">;
      input: Record<string, unknown>;
    }
  | { op: "windows" }
  | { op: "focus_window"; id: number }
  /** The element under a point, or the focused one, from AT-SPI. Null when there's no tree there. */
  | { op: "inspect"; x?: number; y?: number }
  /** A command run as the owner, never with sudo. */
  | { op: "exec"; command: string; timeoutMs: number }
  /** Base64. Written into ~/Downloads/Hatbot unless `path` is given (which needs approval brain-side). */
  | { op: "put_file"; name: string; data: string; path?: string }
  | { op: "get_file"; path: string }
  | { op: "live"; on: boolean }
  /** Only while the owner has control from Live. */
  | { op: "live_input"; input: LiveInput }
  /** A pause, or the end of one, from the web or iOS; a status follows. */
  | { op: "pause"; paused: boolean }
  /** Turns "Let Hatbot use this computer" off; only the computer turns it on again. */
  | { op: "disable" };

export type ComputerResult =
  | { op: "status"; status: ComputerStatus }
  | { op: "claim"; screen: ComputerScreen }
  | { op: "release" }
  /** A JPEG, base64, scaled to fit the model's screenshot size. */
  | { op: "screenshot"; data: string; width: number; height: number }
  | { op: "zoom"; data: string; width: number; height: number }
  | { op: "action"; result: AgentActionResult }
  | { op: "windows"; windows: ComputerWindow[] }
  | { op: "focus_window" }
  | { op: "inspect"; element: AgentElement | null }
  | { op: "exec"; result: ShellResult }
  | { op: "put_file"; path: string }
  | { op: "get_file"; name: string; data: string }
  | { op: "live" }
  | { op: "live_input" }
  | { op: "pause" }
  | { op: "disable" };

/**
 * Why a request failed, so the brain can wait rather than give up: `owner` when the owner took the
 * mouse or keyboard back, `locked`, `paused`, `disabled`, `hidden` for typing into a blacked-out window.
 */
export type ComputerErrorCode =
  | "owner"
  | "locked"
  | "paused"
  | "disabled"
  | "hidden"
  | "busy"
  | "failed";

export type ComputerMessage =
  | ComputerHello
  | { t: "req"; id: number; req: ComputerRequest }
  | { t: "res"; id: number; ok: true; res: ComputerResult }
  | { t: "res"; id: number; ok: false; code: ComputerErrorCode; error: string }
  /** Unasked, from the agent: the switch, a pause, the lock or the owner coming back changed. */
  | { t: "status"; status: ComputerStatus };
