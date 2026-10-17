import { expect, test } from "bun:test";
import { withDelta } from "../src/delta";

test("streamed text is added where it starts, once", () => {
  expect(withDelta("Hello", { text: " world", at: 5 })).toBe("Hello world");
  // Loaded mid-reply: the page already has part of what this delta carries.
  expect(withDelta("Hello wo", { text: " world", at: 5 })).toBe("Hello world");
  expect(withDelta("Hello world", { text: " world", at: 5 })).toBe("Hello world");
  // From a brain without `at`, or after text was missed: added as it comes.
  expect(withDelta("Hello", { text: " world" })).toBe("Hello world");
  expect(withDelta("He", { text: " world", at: 5 })).toBe("He world");
});
