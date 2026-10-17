import { expect, test } from "bun:test";
import { KEY_NAMES, MODIFIER_NAMES, readKey } from "@hatbot/shared/keys";
import { browserKey, combo, KeyError, keysym, MODIFIERS, modifiers, NAMED } from "../src/keys";
import { takeFrame } from "../src/x11";

test("model key names become xdotool keysyms", () => {
  expect(combo("ctrl+shift+Escape")).toBe("ctrl+shift+Escape");
  expect(combo("Return")).toBe("Return");
  expect(combo("enter")).toBe("Return");
  expect(combo("Page_Down")).toBe("Page_Down");
  expect(combo("pagedown")).toBe("Page_Down");
  expect(combo("alt+Tab")).toBe("alt+Tab");
  expect(combo("ctrl+s")).toBe("ctrl+s");
  expect(combo("cmd+l")).toBe("super+l");
  expect(combo("f5")).toBe("F5");
  expect(combo("ctrl++")).toBe("ctrl+plus");
  expect(combo("+")).toBe("plus");
  expect(combo("ctrl+/")).toBe("ctrl+slash");
  expect(() => combo("ctrl+")).toThrow(KeyError);
  expect(() => combo("a b")).toThrow(KeyError);
});

test("only listed names are pressed: no keycodes, hex or Unicode keysyms, or modifiers after the key", () => {
  for (const name of [
    "36",
    "104",
    "0xff0d",
    "0x20",
    "U0020",
    "KP_Space",
    "Linefeed",
    "ISO_Enter",
    "3270_Enter",
    "XF86Back",
    "Return+shift",
    "KP_Enter+a",
    "space+Tab",
    "\u0085",
  ])
    expect(() => combo(name)).toThrow(KeyError);
  expect(combo("Control_L+l")).toBe("ctrl+l");
  expect(combo("KP_Enter")).toBe("KP_Enter");
  expect(combo("Next")).toBe("Next");
});

test("desktop-agent presses exactly the names the brain's checks read, as the same keys", () => {
  const names = [
    ...Object.keys(NAMED),
    ...Object.keys(MODIFIERS),
    ...Object.keys(MODIFIER_NAMES),
    ...Object.keys(KEY_NAMES),
    "F1",
    "f24",
    "F25",
    "a",
    "Z",
    "5",
    "+",
    "ą",
    "€",
    "36",
    "0xff0d",
    "U0020",
    "KP_Space",
    "Linefeed",
    "ISO_Left_Tab",
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

test("click modifiers must be modifiers", () => {
  expect(modifiers("ctrl+shift")).toEqual(["ctrl", "shift"]);
  expect(modifiers(undefined)).toEqual([]);
  expect(() => modifiers("ctrl+a")).toThrow(KeyError);
});

test("browser keys: printable characters are typed, the rest are keysyms", () => {
  expect(browserKey("a")).toBeNull();
  expect(browserKey("é")).toBeNull();
  expect(browserKey("Enter")).toBe("Return");
  expect(browserKey("ArrowLeft")).toBe("Left");
  expect(browserKey("Control")).toBe("Control_L");
  expect(browserKey("Backspace")).toBe("BackSpace");
});

test("multipart MJPEG frames are split by Content-length", () => {
  const enc = new TextEncoder();
  const part = (body: number[]) => [
    ...enc.encode(`--ffmpeg\r\nContent-type: image/jpeg\r\nContent-length: ${body.length}\r\n\r\n`),
    ...body,
    ...enc.encode("\r\n"),
  ];
  const buf = new Uint8Array([...part([1, 2, 3]), ...part([4, 5])]);
  const a = takeFrame(buf);
  expect(a && [...a.jpeg]).toEqual([1, 2, 3]);
  const rest = buf.slice(a?.end);
  const b = takeFrame(rest);
  expect(b && [...b.jpeg]).toEqual([4, 5]);
  expect(takeFrame(new Uint8Array(buf.slice(0, 20)))).toBeNull();
});
