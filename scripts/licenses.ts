// Lists every installed dependency's licence, and fails on a copyleft or unknown one, MPL included.
// Run after `bun install`: `bun run licenses`.
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";

/** Licences that ask nothing of Hatbot's own code. */
const PERMISSIVE = new Set([
  "0BSD",
  "Apache-2.0",
  "BlueOak-1.0.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "CC-BY-4.0",
  "CC0-1.0",
  "ISC",
  "MIT",
  "MIT-0",
  "Python-2.0",
  "Unlicense",
  "Zlib",
]);

/**
 * Copyleft packages allowed anyway, by name, each with why. Only build tools whose code doesn't end
 * up in anything Hatbot ships belong here.
 */
const EXCEPTIONS: [RegExp, string][] = [
  [
    /^lightningcss(-.+)?$/,
    "MPL-2.0: Vite's CSS minifier, a dependency of Vite itself. It runs when the web app is built; none of it is in the build.",
  ],
];

type Pkg = { name: string; version: string; license: string };

/** Every package under a node_modules folder, Bun's .bun store included. */
function packages(dir: string, out = new Map<string, Pkg>()): Map<string, Pkg> {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, e.name);
    if (e.name === ".bun") {
      for (const store of readdirSync(path)) packages(join(path, store, "node_modules"), out);
    } else if (e.name.startsWith("@")) {
      for (const scoped of readdirSync(path)) read(join(path, scoped), out);
    } else if (!e.name.startsWith(".")) {
      read(path, out);
    }
  }
  return out;
}

/** Workspaces link to each other (the web to plugins, plugins to the web's kit): each is read once. */
const seen = new Set<string>();

function read(dir: string, out: Map<string, Pkg>) {
  const file = join(dir, "package.json");
  if (!existsSync(file)) return;
  const real = realpathSync(dir);
  if (seen.has(real)) return;
  seen.add(real);
  const j = JSON.parse(readFileSync(file, "utf8"));
  // Old package.json files say it as {type} or a list of them.
  const license: string =
    typeof j.license === "string"
      ? j.license
      : (j.license?.type ??
        (j.licenses as { type: string }[] | undefined)?.map((l) => l.type).join(" OR ") ??
        "");
  out.set(`${j.name}@${j.version}`, { name: j.name, version: j.version, license });
  packages(join(dir, "node_modules"), out);
}

/** An SPDX expression is fine if one of its OR choices is all permissive. */
function permissive(expr: string): boolean {
  return expr
    .replace(/[()]/g, "")
    .split(/\s+OR\s+/i)
    .some((choice) => choice.split(/\s+AND\s+/i).every((l) => PERMISSIVE.has(l.trim())));
}

const root = join(import.meta.dir, "..");
const all = packages(join(root, "node_modules"));
for (const w of ["apps", "packages", "plugins"])
  for (const name of readdirSync(join(root, w))) packages(join(root, w, name, "node_modules"), all);

const list = [...all.values()]
  .filter((p) => !p.name.startsWith("@hatbot/"))
  .sort((a, b) => a.name.localeCompare(b.name));
const bad: string[] = [];
for (const p of list) {
  const allowed = EXCEPTIONS.find(([re]) => re.test(p.name));
  const note = permissive(p.license)
    ? ""
    : allowed
      ? `  (allowed: ${allowed[1]})`
      : "  ← not allowed";
  console.log(`${p.name}@${p.version}: ${p.license || "no licence given"}${note}`);
  if (!permissive(p.license) && !allowed)
    bad.push(`${p.name}@${p.version} (${p.license || "none"})`);
}
console.log(`\n${list.length} packages.`);
if (bad.length) {
  console.error(
    `\nNot allowed: ${bad.join(", ")}.\nHatbot takes no copyleft dependencies. A licence missing from the list in scripts/licenses.ts needs checking before it's added there.`,
  );
  process.exit(1);
}
