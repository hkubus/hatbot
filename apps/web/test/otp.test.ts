import { expect, test } from "bun:test";
import { backspace, complete, pasted, slots, typed } from "../src/otp";

test("typing fills one box and moves on", () => {
  let code = "";
  for (const [i, d] of [..."123456"].entries()) code = typed(code, i, d).code;
  expect(complete(code)).toBe("123456");
  expect(typed("", 0, "7")).toEqual({ code: "7     ", focus: 1 });
  expect(typed("12345 ", 5, "6").focus).toBe(5);
});

test("fixing one digit changes that digit only", () => {
  // Typed into a full box, the caret after or before the old digit.
  expect(typed("123456", 2, "39").code).toBe("129456");
  expect(typed("123456", 2, "93").code).toBe("129456");
  expect(typed("123456", 2, "9").code).toBe("129456");
  // Clearing one leaves the others where they are.
  const cleared = typed("123456", 2, "").code;
  expect(cleared).toBe("12 456");
  expect(slots(cleared)).toEqual(["1", "2", "", "4", "5", "6"]);
  expect(complete(cleared)).toBeNull();
  expect(typed(cleared, 2, "0").code).toBe("120456");
  // A letter changes nothing.
  expect(typed("123456", 2, "3a")).toEqual({ code: "123456", focus: 2 });
});

test("a pasted or autofilled code fills every box", () => {
  expect(pasted("", 0, "123 456")).toEqual({ code: "123456", focus: 5 });
  expect(pasted("99    ", 3, "Your code: 654321")).toEqual({ code: "654321", focus: 5 });
  // Part of one fills from the box it lands in.
  expect(pasted("12    ", 2, "34")).toEqual({ code: "1234  ", focus: 4 });
  // Autofill arrives as a change to the first box.
  expect(typed("", 0, "246810")).toEqual({ code: "246810", focus: 5 });
});

test("Backspace in an empty box clears the one before", () => {
  expect(backspace("123   ", 3)).toEqual({ code: "12    ", focus: 2 });
  expect(backspace("      ", 0)).toEqual({ code: "      ", focus: 0 });
});
