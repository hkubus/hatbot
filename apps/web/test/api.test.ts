import { expect, test } from "bun:test";
import { ApiError, errorText } from "../src/api";

test("a lost connection says so, whatever the action's own fallback", () => {
  expect(errorText(new TypeError("Failed to fetch"), "Couldn't save.")).toBe(
    "Couldn't reach Hatbot.",
  );
  expect(errorText(new DOMException("", "TimeoutError"), "Couldn't save.")).toBe(
    "Couldn't reach Hatbot.",
  );
  expect(errorText(new ApiError(400, "That name is taken."), "Couldn't save.")).toBe(
    "That name is taken.",
  );
  expect(errorText(new Error("bug"), "Couldn't save.")).toBe("Couldn't save.");
});
