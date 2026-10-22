// Key names from the model ("ctrl+shift+Escape", "Page_Down", "enter") and from the browser
// (KeyboardEvent.key) to X keysyms for xdotool. Only names on the brain's lists (packages/shared/src/keys.ts)
// are pressed: xdotool would also take a keycode ("36"), a hex or Unicode keysym ("0xff0d", "U0020") or any
// other keysym, and press Enter under a name the brain's checks don't read as Enter. browser.ts reads them
// here too.
import { comboParts, readKey } from "@hatbot/shared/keys";

/** X keysyms for the keys shared's KEY_NAMES press. Prior and Next are X's names for Page_Up and Page_Down. */
const KEYSYMS: Record<string, string> = {
  enter: "Return",
  space: "space",
  tab: "Tab",
  escape: "Escape",
  backspace: "BackSpace",
  delete: "Delete",
  insert: "Insert",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  home: "Home",
  end: "End",
  pageup: "Page_Up",
  pagedown: "Page_Down",
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

export const modifier = (name: string) => {
  const k = readKey(name);
  return k && "mod" in k ? k.mod : undefined;
};

/** One key name to a keysym, from the lists only. */
export function keysym(name: string): string {
  const k = readKey(name);
  if (k && "mod" in k) return k.mod;
  if (k && [...name].length === 1) return SYMBOLS[name] ?? name;
  if (k) {
    // The brain reads KP_Enter as Enter; it's pressed as itself.
    if (name.toLowerCase() === "kp_enter") return "KP_Enter";
    if (/^f\d+$/.test(k.key)) return `F${k.key.slice(1)}`;
    if (Object.hasOwn(KEYSYMS, k.key)) return KEYSYMS[k.key] as string;
  }
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
  const parts = comboParts(t);
  if (parts.some((p) => !p)) throw new KeyError(`Can't read the key combination "${text}".`);
  if (parts.slice(0, -1).some((p) => !modifier(p)))
    throw new KeyError(`"${text}": put the modifiers first and one key last, like ctrl+shift+t.`);
  return parts.map(keysym).join("+");
}

/** Modifiers held during a click or scroll ("ctrl+shift"); each must be a modifier. */
export function modifiers(text: string | null | undefined): string[] {
  if (!text?.trim()) return [];
  return text.split("+").map((p) => {
    const m = modifier(p.trim());
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
  if (Object.hasOwn(special, key)) return special[key] as string;
  try {
    return keysym(key);
  } catch (err) {
    if (/^[A-Za-z][A-Za-z0-9_]*$/.test(key)) return key;
    throw err;
  }
}
