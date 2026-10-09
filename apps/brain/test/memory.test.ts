import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HATBOT, MemoryError, MemoryStore } from "../src/memory/store";

const YOU = { name: "You", email: "owner@local" };
let dir: string;
let mem: MemoryStore;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "hatbot-mem-"));
  mem = new MemoryStore(dir);
  await mem.init();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("write commits, read returns, log lists", async () => {
  const sha = await mem.write(
    "projects/hatbot.md",
    "# Hatbot\nShips in M1",
    HATBOT,
    "Note Hatbot project",
  );
  expect(sha).toMatch(/^[0-9a-f]{40}$/);
  expect(await mem.read("projects/hatbot.md")).toBe("# Hatbot\nShips in M1\n");
  const [latest] = await mem.log();
  expect(latest).toMatchObject({
    sha,
    author: "Hatbot",
    message: "Note Hatbot project",
    files: ["projects/hatbot.md"],
  });
  expect((await mem.tree()).map((f) => f.path)).toEqual(["INDEX.md", "projects/hatbot.md"]);
});

test("unchanged content makes no commit", async () => {
  await mem.write("a.md", "x", HATBOT, "one");
  expect(await mem.write("a.md", "x\n", HATBOT, "two")).toBeNull();
});

test("search finds lines case-insensitively", async () => {
  await mem.write("homelab.md", "# Homelab\nForgejo runs on CT 110", YOU, "homelab");
  expect(await mem.search("forgejo")).toEqual([
    { path: "homelab.md", line: 2, text: "Forgejo runs on CT 110" },
  ]);
});

test("diff and revert", async () => {
  await mem.write("prefs.md", "tea", YOU, "prefs");
  const sha = (await mem.write("prefs.md", "coffee", HATBOT, "change drink")) as string;
  expect(await mem.diff(sha)).toContain("+coffee");
  const revert = await mem.revert(sha, YOU);
  expect(revert).not.toBeNull();
  expect(await mem.read("prefs.md")).toBe("tea\n");
  expect((await mem.log(1))[0]?.message).toBe('Revert "change drink"');
});

test("refuses paths outside the repo, into .git, or non-markdown writes", async () => {
  for (const p of ["../x.md", "/etc/passwd", ".git/config", "a/../../x.md", ""]) {
    expect(() => mem.resolve(p)).toThrow(MemoryError);
  }
  expect(mem.write("x.sh", "echo", HATBOT, "x")).rejects.toThrow(MemoryError);
});

test("concurrent writes all commit", async () => {
  await Promise.all([1, 2, 3, 4].map((i) => mem.write(`n${i}.md`, `${i}`, HATBOT, `n${i}`)));
  expect((await mem.log()).length).toBe(5);
});
