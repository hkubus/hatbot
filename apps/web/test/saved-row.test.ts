import { expect, test } from "bun:test";
import { parseLimit, parseName } from "../src/saved-row";

test("a spending limit must be more than $0, and a cleared one isn't taken as nothing", () => {
  expect(parseLimit("")).toEqual({ error: "Give an amount." });
  expect(parseLimit("   ")).toEqual({ error: "Give an amount." });
  expect(parseLimit("0")).toEqual({ error: "A limit must be more than $0." });
  expect(parseLimit("-5")).toEqual({ error: "A limit must be more than $0." });
  expect(parseLimit("abc")).toEqual({ error: "Give an amount." });
  expect(parseLimit("12.5")).toEqual({ value: 12.5 });
  expect(parseLimit("$ 3")).toEqual({ value: 3 });
  expect(parseLimit("0.004")).toEqual({ error: "A limit must be more than $0." });
  expect(parseLimit("2.499")).toEqual({ value: 2.5 });
});

test("what's kept for alerts may be $0, but not less or nothing", () => {
  expect(parseLimit("0", true)).toEqual({ value: 0 });
  expect(parseLimit("", true)).toEqual({ error: "Give an amount, $0 or more." });
  expect(parseLimit("-1", true)).toEqual({ error: "It can't be below $0." });
});

test("an empty name isn't saved", () => {
  expect(parseName("  ")).toEqual({ error: "Your name can't be empty." });
  expect(parseName(" Kuba ")).toEqual({ value: "Kuba" });
});
