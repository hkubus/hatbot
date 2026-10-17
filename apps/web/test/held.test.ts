import { expect, test } from "bun:test";
import { Held } from "../src/held";

test("what's held down is let go of, the last pressed first, once", () => {
  const held = new Held();
  held.note({ t: "key", key: "Control", down: true });
  held.note({ t: "key", key: "Alt", down: true });
  held.note({ t: "key", key: "Shift", down: true });
  held.note({ t: "key", key: "Shift", down: false });
  held.note({ t: "button", button: 1, down: true, x: 5, y: 5 });
  held.note({ t: "move", x: 30, y: 40 });
  expect(held.ups()).toEqual([
    { t: "button", button: 1, down: false, x: 30, y: 40 },
    { t: "key", key: "Alt", down: false },
    { t: "key", key: "Control", down: false },
  ]);
  expect(held.ups()).toEqual([]);
});
