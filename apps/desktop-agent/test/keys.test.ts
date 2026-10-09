import { expect, test } from "bun:test";
import { browserKey, combo, KeyError, modifiers } from "../src/keys";
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
