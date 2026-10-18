import { expect, test } from "bun:test";
import { parseLimit } from "../src/saved-row";

test("a spending limit must be more than $0, and a cleared one isn't taken as nothing", () => {
  expect(parseLimit("")).toEqual({ error: "Give an amount." });
  expect(parseLimit("abc")).toEqual({ error: "Give an amount." });
  expect(parseLimit("0")).toEqual({ error: "A limit must be more than $0." });
  // Rounded to cents first.
  expect(parseLimit("0.004")).toEqual({ error: "A limit must be more than $0." });
  expect(parseLimit("$ 2.499")).toEqual({ value: 2.5 });
  // What's kept for alerts may be $0.
  expect(parseLimit("0", true)).toEqual({ value: 0 });
});
