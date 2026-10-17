import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = join(import.meta.dir, "../src/plugins");

test("every plugin settings form that saves asks before leaving with unsaved edits", () => {
  const forms = readdirSync(DIR).filter((f) => f.endsWith(".tsx") && f !== "index.tsx");
  expect(forms).toContain("homeassistant.tsx");
  for (const f of forms) {
    const source = readFileSync(join(DIR, f), "utf8");
    if (!/\bsave\(/.test(source)) continue;
    expect(source, f).toMatch(/useLeaveGuard\(/);
  }
});
