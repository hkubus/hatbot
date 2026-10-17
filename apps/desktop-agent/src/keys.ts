// Key names from the model ("ctrl+shift+Escape", "Page_Down", "enter") and from the browser
// (KeyboardEvent.key) to X keysyms for xdotool. Only names on these lists are pressed: xdotool would also
// take a keycode ("36"), a hex or Unicode keysym ("0xff0d", "U0020") or any other keysym, and press Enter
// under a name the brain's checks don't read as Enter. The brain reads names with the same lists
// (packages/shared/src/keys.ts); keys.test.ts keeps the two the same.

export const MODIFIERS: Record<string, string> = {
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

export const NAMED: Record<string, string> = {
  return: "Return",
  enter: "Return",
  kp_enter: "KP_Enter",
  escape: "Escape",
  esc: "Escape",
  tab: "Tab",
  backspace: "BackSpace",
  delete: "Delete",
  del: "Delete",
  insert: "Insert",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  arrowup: "Up",
  arrowdown: "Down",
  arrowleft: "Left",
  arrowright: "Right",
  home: "Home",
  end: "End",
  page_up: "Page_Up",
  pageup: "Page_Up",
  pgup: "Page_Up",
  prior: "Prior",
  page_down: "Page_Down",
  pagedown: "Page_Down",
  pgdn: "Page_Down",
  next: "Next",
  space: "space",
  menu: "Menu",
  contextmenu: "Menu",
  print: "Print",
  printscreen: "Print",
  capslock: "Caps_Lock",
  caps_lock: "Caps_Lock",
};

const SYMBOLS: Record<string, string> = {
  " ": "space",
  "+": "plus",
  "-": "minus",
  "=": "equal",
  "/": "slash",
  "\\": "backslash",
  ".": "period",
  ",": "comma",
  ";": "semicolon",
  "'": "apostrophe",
  "`": "grave",
  "[": "bracketleft",
  "]": "bracketright",
  "!": "exclam",
  "@": "at",
  "#": "numbersign",
  $: "dollar",
  "%": "percent",
  "^": "asciicircum",
  "&": "ampersand",
  "*": "asterisk",
  "(": "parenleft",
  ")": "parenright",
  _: "underscore",
  ":": "colon",
  '"': "quotedbl",
  "<": "less",
  ">": "greater",
  "?": "question",
  "{": "braceleft",
  "}": "braceright",
  "|": "bar",
  "~": "asciitilde",
};

export class KeyError extends Error {}

/** A letter, digit, punctuation mark or symbol, not a control character or a space. */
const printable = (s: string) => [...s].length === 1 && /^[\p{L}\p{N}\p{P}\p{S}]$/u.test(s);

/** One key name to a keysym, from the lists only. */
export function keysym(name: string): string {
  if ([...name].length === 1) {
    if (!printable(name)) throw new KeyError(`Unknown key "${name}".`);
    return SYMBOLS[name] ?? name;
  }
  const lower = name.toLowerCase();
  if (MODIFIERS[lower]) return MODIFIERS[lower];
  if (NAMED[lower]) return NAMED[lower];
  const f = /^f([1-9]|1\d|2[0-4])$/.exec(lower);
  if (f) return `F${f[1]}`;
  throw new KeyError(
    `Unknown key "${name}". Use a key's name (Return, Tab, Page_Down, F5) or a character.`,
  );
}

/**
 * "ctrl+shift+Escape" to "ctrl+shift+Escape" in xdotool's syntax. A lone "+" is the plus key. Modifiers
 * come first and one key last: xdotool presses them in order, so "Return+shift" would be a plain Return.
 */
export function combo(text: string): string {
  const t = text.trim();
  if (!t) throw new KeyError("Empty key name.");
  if (t === "+") return "plus";
  const parts = t.endsWith("++") ? [...t.slice(0, -2).split("+"), "+"] : t.split("+");
  if (parts.some((p) => !p)) throw new KeyError(`Can't read the key combination "${text}".`);
  if (parts.slice(0, -1).some((p) => !MODIFIERS[p.toLowerCase()]))
    throw new KeyError(`"${text}": put the modifiers first and one key last, like ctrl+shift+t.`);
  return parts.map(keysym).join("+");
}

/** Modifiers held during a click or scroll ("ctrl+shift"); each must be a modifier. */
export function modifiers(text: string | null | undefined): string[] {
  if (!text?.trim()) return [];
  return text.split("+").map((p) => {
    const m = MODIFIERS[p.trim().toLowerCase()];
    if (!m) throw new KeyError(`"${p}" is not a modifier key (ctrl, shift, alt, super).`);
    return m;
  });
}

/**
 * A browser KeyboardEvent.key for live input, or null for printable characters (typed instead). This is
 * your own keyboard, so a key off the lists (ScrollLock, a media key) goes to xdotool by its name.
 */
export function browserKey(key: string): string | null {
  if ([...key].length === 1) return null;
  const special: Record<string, string> = {
    Shift: "Shift_L",
    Control: "Control_L",
    Alt: "Alt_L",
    Meta: "Super_L",
    AltGraph: "ISO_Level3_Shift",
  };
  if (special[key]) return special[key];
  try {
    return keysym(key);
  } catch (err) {
    if (/^[A-Za-z][A-Za-z0-9_]*$/.test(key)) return key;
    throw err;
  }
}
