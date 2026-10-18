import { expect, test } from "bun:test";
import { KEY_NAMES, MODIFIER_NAMES, readKey } from "@hatbot/shared/keys";
import { browserKey, combo, KeyError, keysym, MODIFIERS, modifiers, NAMED } from "../src/keys";

test("only listed names are pressed, modifiers first: no keycodes, hex keysyms or object keys", () => {
  for (const [name, sym] of [
    ["ctrl+shift+Escape", "ctrl+shift+Escape"],
    ["enter", "Return"],
    ["cmd+l", "super+l"],
    ["Control_L+l", "ctrl+l"],
    ["f5", "F5"],
    ["ctrl++", "ctrl+plus"],
    ["+", "plus"],
  ] as const)
    expect([name, combo(name)]).toEqual([name, sym]);
  for (const name of [
    "ctrl+",
    "a b",
    "36",
    "0xff0d",
    "Return+shift",
    "\u0085",
    // Every object has these, but they aren't keys.
    "constructor+Return",
    "__proto__+Return",
  ])
    expect(() => combo(name)).toThrow(KeyError);
  expect(() => modifiers("constructor")).toThrow(KeyError);
  expect(browserKey("constructor")).toBe("constructor");
});

test("desktop-agent presses exactly the names the brain's checks read, as the same keys", () => {
  const names = [
    ...Object.keys(NAMED),
    ...Object.keys(MODIFIERS),
    ...Object.keys(MODIFIER_NAMES),
    ...Object.keys(KEY_NAMES),
    ...["F1", "f24", "F25", "a", "+", "ą", "36", "0xff0d", "U0020", "KP_Space", "ISO_Left_Tab"],
    ...["constructor", "__proto__"],
  ];
  for (const name of names) {
    const read = readKey(name);
    let sym: string | null;
    try {
      sym = keysym(name);
    } catch {
      sym = null;
    }
    // Both take it or neither does.
    expect([name, sym !== null]).toEqual([name, read !== null]);
    if (!read || sym === null) continue;
    // Return, KP_Enter and space are what the brain reads as Enter and Space; nothing else is.
    const key = "key" in read ? read.key : null;
    expect([name, ["Return", "KP_Enter"].includes(sym)]).toEqual([name, key === "enter"]);
    expect([name, sym === "space"]).toEqual([name, key === "space"]);
  }
});
