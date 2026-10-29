// Preloaded by bunfig.toml: removes the test apps' temporary directories after the run.
import { afterAll } from "bun:test";
import { rmSync } from "node:fs";
import { MODELS } from "@hatbot/plugin-anthropic";
import { addPrices } from "../src/spend";
import { tempDirs, tempTeach } from "./helpers";

// Tests' models are fakes, so Claude's prices come from its catalogue rather than a running provider.
addPrices(MODELS);

afterAll(() => {
  for (const t of tempTeach.splice(0)) t.close();
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
