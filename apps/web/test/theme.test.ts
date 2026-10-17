import { expect, test } from "bun:test";
import { barColor } from "../src/theme";

const LIGHT_TAG = "(prefers-color-scheme: light)";
const DARK_TAG = "(prefers-color-scheme: dark)";

test("a chosen theme colours the browser's bar whatever the system's scheme", () => {
  expect(barColor("dark", LIGHT_TAG)).toBe("#161617");
  expect(barColor("dark", DARK_TAG)).toBe("#161617");
  expect(barColor("light", DARK_TAG)).toBe("#f5f5f7");
  expect(barColor("light", LIGHT_TAG)).toBe("#f5f5f7");
});

test("the system theme gives each tag its own scheme's colour back", () => {
  expect(barColor("system", LIGHT_TAG)).toBe("#f5f5f7");
  expect(barColor("system", DARK_TAG)).toBe("#161617");
});
