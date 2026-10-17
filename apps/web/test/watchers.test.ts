import { expect, test } from "bun:test";
import type { Watcher } from "@hatbot/shared";
import { installDom } from "./dom";

installDom();
const { blank, bodyOf, sourceOf, trouble } = await import("../src/pages/Watchers");

test("Try it needs only where to look: an unfinished condition waits for Save", () => {
  const form = { ...blank, url: "https://shop.example/item", selector: ".stock", when: "contains" };
  expect(sourceOf(form as typeof blank)).toEqual({
    kind: "page",
    url: "https://shop.example/item",
    selector: ".stock",
  });
  expect(bodyOf(form as typeof blank)).toBe("Say what text to look for.");
  // What Try it can't do without is still its own error.
  const tool = { ...blank, kind: "tool" as const, tool: "pbs_status", input: "{oops" };
  expect(sourceOf(tool)).toBe("The tool's input isn't JSON.");
});

test("a watcher switched off for counting too often isn't shown as one that can't read", () => {
  const w = (patch: Partial<Watcher>) => ({ lastError: null, errors: 0, ...patch }) as Watcher;
  expect(trouble(w({}))).toBeNull();
  expect(trouble(w({ lastError: "HTTP 503", errors: 1 }))).toEqual({
    short: "Can't read",
    long: "Can't read it: HTTP 503",
  });
  expect(trouble(w({ lastError: "HTTP 503", errors: 3 }))?.long).toBe(
    "Can't read it: HTTP 503 (3 times in a row)",
  );
  const often = "It counted more than 12 times in a day, so it was switched off.";
  expect(trouble(w({ lastError: often, errors: 0, enabled: false }))).toEqual({
    short: "Off",
    long: often,
  });
});
