// Preloaded by bunfig.toml: removes the test apps' temporary directories after the run.
import { afterAll } from "bun:test";
import { rmSync } from "node:fs";
import { tempDirs } from "./helpers";

afterAll(() => {
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
