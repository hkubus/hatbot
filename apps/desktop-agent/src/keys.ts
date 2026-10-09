// Key names from the model ("ctrl+shift+Escape", "Page_Down", "enter") and from the browser
// (KeyboardEvent.key) to X keysyms for xdotool.

const MODIFIERS: Record<string, string> = {
  ctrl: "ctrl",
  control: "ctrl",
  shift: "shift",
  alt: "alt",
  option: "alt",
  super: "super",
  meta: "super",
  cmd: "super",
  command: "super",
  win: "super",
  windows: "super",
};

const NAMED: Record<string, string> = {
  return: "Return",
  enter: "Return",
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
  page_down: "Page_Down",
  pagedown: "Page_Down",
  pgdn: "Page_Down",
  space: "space",
  menu: "Menu",
  print: "Print",
  capslock: "Caps_Lock",
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

/** One key name to a keysym. Unknown multi-letter names are passed through (xdotool knows many keysyms). */
export function keysym(name: string): string {
  if (name.length === 1) return SYMBOLS[name] ?? name;
  const lower = name.toLowerCase();
  if (MODIFIERS[lower]) return MODIFIERS[lower];
  if (NAMED[lower]) return NAMED[lower];
  const f = /^f([1-9]|1\d|2[0-4])$/.exec(lower);
  if (f) return `F${f[1]}`;
  if (!/^[A-Za-z0-9_]+$/.test(name)) throw new KeyError(`Unknown key "${name}".`);
  return name;
}

/** "ctrl+shift+Escape" to "ctrl+shift+Escape" in xdotool's syntax. A lone "+" is the plus key. */
export function combo(text: string): string {
  const t = text.trim();
  if (!t) throw new KeyError("Empty key name.");
  if (t === "+") return "plus";
  const parts = t.endsWith("++") ? [...t.slice(0, -2).split("+"), "+"] : t.split("+");
  if (parts.some((p) => !p)) throw new KeyError(`Can't read the key combination "${text}".`);
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

/** A browser KeyboardEvent.key for live input, or null for printable characters (typed instead). */
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
  return keysym(key);
}
