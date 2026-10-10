// Preloaded by bunfig.toml: removes the test apps' temporary directories after the run.
import { afterAll } from "bun:test";
import { rmSync } from "node:fs";
import { tempDirs, tempTeach } from "./helpers";

afterAll(() => {
  for (const t of tempTeach.splice(0)) t.close();
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
