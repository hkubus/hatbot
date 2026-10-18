import { expect, test } from "bun:test";
import { pasted, typed } from "../src/otp";

test("typing changes one box and moves on; fixing one digit changes that digit only", () => {
  expect(typed("", 0, "7")).toEqual({ code: "7     ", focus: 1 });
  // Typed into a full box, the caret after or before the old digit.
  expect(typed("123456", 2, "39").code).toBe("129456");
  expect(typed("123456", 2, "93").code).toBe("129456");
  // Clearing one leaves the others where they are.
  expect(typed("123456", 2, "").code).toBe("12 456");
  // A letter changes nothing.
  expect(typed("123456", 2, "3a")).toEqual({ code: "123456", focus: 2 });
});

test("a pasted or autofilled code fills every box", () => {
  expect(pasted("99    ", 3, "Your code: 654321")).toEqual({ code: "654321", focus: 5 });
  // Part of one fills from the box it lands in.
  expect(pasted("12    ", 2, "34")).toEqual({ code: "1234  ", focus: 4 });
  // Autofill arrives as a change to the first box.
  expect(typed("", 0, "246810")).toEqual({ code: "246810", focus: 5 });
});
