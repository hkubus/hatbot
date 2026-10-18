// A box's build (PLAN.md §21.1), run by hatbox-build@<id>: a throwaway unit of its own user, with no
// network, that sees only this folder. Macros and plugins run code at build time, which is why it isn't
// the agent or the brain that builds. From src/, where the agent put the files and installed the
// packages, it writes page.html, the page inlined into one file, and server.js, the backend in one
// script. What it prints is the build's output, which the model reads.
import { existsSync } from "node:fs";
import { join } from "node:path";

const src = join(process.cwd(), "src");

async function build(config: Bun.BuildConfig, out: string): Promise<boolean> {
  let result: Bun.BuildOutput;
  try {
    result = await Bun.build({ ...config, throw: false });
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return false;
  }
  for (const log of result.logs) console.error(String(log));
  const [first] = result.outputs;
  if (!result.success || !first) return false;
  await Bun.write(out, await first.text());
  return true;
}

const page = await build(
  // compile with a browser target inlines the scripts, styles and assets into the HTML.
  { entrypoints: [join(src, "index.html")], target: "browser", compile: true, minify: true },
  "page.html",
);
const server =
  !existsSync(join(src, "server.ts")) ||
  (await build({ entrypoints: [join(src, "server.ts")], target: "bun" }, "server.js"));
if (!page || !server) process.exit(1);
console.log("Built.");
