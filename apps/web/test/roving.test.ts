import { expect, test } from "bun:test";
import { moveFocus } from "../src/roving";

let focused = "";
const items = ["a", "b", "c"].map((name) => ({ name, focus: () => (focused = name) }));
const press = (key: string, on: number, ends = true, mods: Partial<KeyboardEvent> = {}) => {
  focused = "";
  let prevented = false;
  const e = { key, target: items[on], preventDefault: () => (prevented = true), ...mods };
  const to = moveFocus(e as unknown as KeyboardEvent, items as unknown as HTMLElement[], "y", ends);
  return { to: (to as unknown as { name: string } | null)?.name ?? null, focused, prevented };
};

test("arrows move the focus along a list and stop at its ends; other keys are left alone", () => {
  expect(press("ArrowDown", 0)).toEqual({ to: "b", focused: "b", prevented: true });
  expect(press("ArrowUp", 1).to).toBe("a");
  expect(press("ArrowDown", 2).to).toBe("c");
  expect(press("ArrowUp", 0).to).toBe("a");
  expect(press("End", 0).to).toBe("c");
  expect(press("Home", 2).to).toBe("a");
  // A page's lists leave Home and End to scrolling.
  expect(press("End", 0, false)).toEqual({ to: null, focused: "", prevented: false });
  // Across the axis, with a modifier (Alt goes to another chat), or from outside the list: not ours.
  expect(press("ArrowRight", 0).to).toBeNull();
  expect(press("ArrowDown", 0, true, { altKey: true }).to).toBeNull();
  expect(press("ArrowDown", 3).to).toBeNull();
});
