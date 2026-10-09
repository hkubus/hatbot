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

/** POST /action. `screenshot` and `zoom` have their own endpoints, which return an image. */
export type AgentAction = {
  name: Exclude<ComputerMember, "screenshot" | "zoom">;
  input: Record<string, unknown>;
};
export type AgentActionResult = { text?: string; x?: number; y?: number };

export type AgentStatus = { ok: true; width: number; height: number; locked: boolean };

/** GET /context: the visible Chromium tab. `text` only with ?text=1. */
export type AgentContext = { url: string | null; title: string | null; text?: string };

/** POST /inspect: the element under a point, or the focused one, for the click policy (PLAN.md §6.1). */
export type AgentElement = {
  tag: string;
  role: string | null;
  type: string | null;
  label: string;
  inForm: boolean;
  /** For Enter on a form field: the label of the form's submit button. */
  submitLabel?: string;
};

/** Messages the brain sends on the /live socket while the owner has control (PLAN.md §10.5). */
export type LiveInput =
  | { t: "move"; x: number; y: number }
  | { t: "button"; button: 1 | 2 | 3; down: boolean; x: number; y: number }
  | { t: "wheel"; dy: number; dx: number; x: number; y: number }
  | { t: "key"; key: string; down: boolean };
