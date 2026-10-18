import { expect, test } from "bun:test";
import { barColor, type Theme } from "../src/theme";

test("a chosen theme colours the browser's bar whatever the system's scheme; system follows it", () => {
  const LIGHT = "#f5f5f7";
  const DARK = "#161617";
  // The bar's colour under the light tag, then under the dark one.
  const cases: [Theme, string, string][] = [
    ["light", LIGHT, LIGHT],
    ["dark", DARK, DARK],
    ["system", LIGHT, DARK],
  ];
  for (const [theme, light, dark] of cases) {
    expect(barColor(theme, "(prefers-color-scheme: light)")).toBe(light);
    expect(barColor(theme, "(prefers-color-scheme: dark)")).toBe(dark);
  }
});
