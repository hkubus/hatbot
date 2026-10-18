// Key names as the desktop presses them: xdotool's keysyms on the screen, Chromium's keys in the browser
// toolset. The brain's checks read every key action through readCombo, and desktop-agent presses only
// names from the same list, so a name the checks can't place (a keycode, a hex or Unicode keysym) is
// refused rather than pressed unseen.

export type Modifier = "ctrl" | "shift" | "alt" | "super";

/** One key combination: the modifiers held, then the key pressed (null for modifiers alone). */
export type Combo = { mods: Modifier[]; key: string | null };

/** Modifier names, lowercased, including X's left and right ones. */
export const MODIFIER_NAMES: Record<string, Modifier> = {
  ctrl: "ctrl",
  control: "ctrl",
  control_l: "ctrl",
  control_r: "ctrl",
  shift: "shift",
  shift_l: "shift",
  shift_r: "shift",
  alt: "alt",
  option: "alt",
  alt_l: "alt",
  alt_r: "alt",
  super: "super",
  meta: "super",
  cmd: "super",
  command: "super",
  win: "super",
  windows: "super",
  super_l: "super",
  super_r: "super",
  meta_l: "super",
  meta_r: "super",
};

/**
 * Named keys, lowercased, to what they press. Several names press the same key: KP_Enter is Enter, and
 * Prior is Page Up. desktop-agent's X keysyms for these are in its keys.ts.
 */
export const KEY_NAMES: Record<string, string> = {
  return: "enter",
  enter: "enter",
  kp_enter: "enter",
  space: "space",
  tab: "tab",
  escape: "escape",
  esc: "escape",
  backspace: "backspace",
  delete: "delete",
  del: "delete",
  insert: "insert",
  up: "up",
  down: "down",
  left: "left",
  right: "right",
  arrowup: "up",
  arrowdown: "down",
  arrowleft: "left",
  arrowright: "right",
  home: "home",
  end: "end",
  page_up: "pageup",
  pageup: "pageup",
  pgup: "pageup",
  prior: "pageup",
  page_down: "pagedown",
  pagedown: "pagedown",
  pgdn: "pagedown",
  next: "pagedown",
  menu: "menu",
  contextmenu: "menu",
  print: "print",
  printscreen: "print",
  capslock: "capslock",
  caps_lock: "capslock",
};

/** One printable character: a letter, digit, punctuation or symbol, not a control or space. */
export const printable = (s: string) => [...s].length === 1 && /^[\p{L}\p{N}\p{P}\p{S}]$/u.test(s);

/** One key name to what it presses: a modifier, a named key, F1 to F24, or a character; null if none. */
export function readKey(name: string): { mod: Modifier } | { key: string } | null {
  if ([...name].length === 1) return printable(name) ? { key: name } : null;
  const lower = name.toLowerCase();
  // Own entries only: every object has a "constructor" and a "__proto__".
  if (Object.hasOwn(MODIFIER_NAMES, lower)) return { mod: MODIFIER_NAMES[lower] as Modifier };
  if (Object.hasOwn(KEY_NAMES, lower)) return { key: KEY_NAMES[lower] as string };
  const f = /^f([1-9]|1\d|2[0-4])$/.exec(lower);
  return f ? { key: `f${f[1]}` } : null;
}

/** "ctrl+shift+t" in parts; a lone "+", or one at the end ("ctrl++"), is the plus key. */
export function comboParts(text: string): string[] {
  const t = text.trim();
  if (t === "+") return ["+"];
  return t.endsWith("++") ? [...t.slice(0, -2).split("+"), "+"] : t.split("+");
}

/**
 * Reads one combination the way both keyboards would press it: modifiers first, then at most one key,
 * last. Null for anything else: a name neither knows, two keys at once, or a modifier after the key
 * (xdotool presses in order, so "Return+shift" is a plain Return).
 */
export function readCombo(text: string): Combo | null {
  const parts = comboParts(text);
  if (!parts.length || parts.some((p) => !p)) return null;
  const mods: Modifier[] = [];
  let key: string | null = null;
  for (const p of parts) {
    const k = readKey(p);
    if (!k || key !== null) return null;
    if ("mod" in k) mods.push(k.mod);
    else key = k.key;
  }
  return { mods, key };
}

/** A key action's text as combinations, one per space-separated name ("ctrl+a Delete"). */
export const combosIn = (text: string) => text.trim().split(/\s+/).filter(Boolean);
