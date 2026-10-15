import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blobSha, HATBOT, MemoryConflict, MemoryError, MemoryStore } from "../src/memory/store";
import { setUpOwner, testApp } from "./helpers";

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

test("updates read and write with no other write in between, so none is lost", async () => {
  await mem.write("notes.md", "# Notes", HATBOT, "Start notes");
  const add = (line: string) =>
    mem.update("notes.md", async (now) => `${now ?? ""}- ${line}\n`, HATBOT, `Add ${line}`);
  await Promise.all(["a", "b", "c", "d"].map(add));
  expect(await mem.read("notes.md")).toBe("# Notes\n- a\n- b\n- c\n- d\n");
  expect(await mem.update("notes.md", () => null, HATBOT, "Nothing")).toBeNull();
});

test("a file's sha is git's, and a write on top of an older copy is refused", async () => {
  await mem.write("a.md", "one", HATBOT, "One");
  const sha = blobSha(await mem.read("a.md"));
  const proc = Bun.spawn(["git", "hash-object", "a.md"], { cwd: dir, stdout: "pipe" });
  expect((await new Response(proc.stdout).text()).trim()).toBe(sha);
  await mem.writeIf("a.md", "two", sha, YOU, "Two");
  await expect(mem.writeIf("a.md", "three", sha, YOU, "Three")).rejects.toBeInstanceOf(
    MemoryConflict,
  );
  expect(await mem.read("a.md")).toBe("two\n");
  // "" is a new file: refused once it exists.
  await expect(mem.writeIf("a.md", "x", "", YOU, "X")).rejects.toBeInstanceOf(MemoryConflict);
  expect(await mem.writeIf("b.md", "new", "", YOU, "New")).toMatch(/^[0-9a-f]{40}$/);
});

test("the memory API sends the sha and answers 409 with what the file is now", async () => {
  const t = await testApp();
  const { cookie } = await setUpOwner(t);
  await t.memory.write("a.md", "one", HATBOT, "One");
  const got = (await (
    await t.call("GET", "/memory/file?path=a.md", undefined, { cookie })
  ).json()) as { content: string; sha: string };
  expect(got.sha).toBe(blobSha("one\n"));
  const put = (content: string) =>
    t.call("PUT", "/memory/file?path=a.md", { content, baseSha: got.sha }, { cookie });
  expect((await put("two")).status).toBe(200);
  const conflict = await put("three");
  expect(conflict.status).toBe(409);
  expect(await conflict.json()).toEqual({
    error: "changed",
    sha: blobSha("two\n"),
    content: "two\n",
  });
});

test("search wants every word, in any line of a file, and ranks files by how much they match", async () => {
  await mem.write("homelab/backups.md", "PBS backs up nightly\nThe NAS keeps backups", HATBOT, "a");
  await mem.write("homelab/nas.md", "The NAS is a Synology", HATBOT, "b");
  await mem.write(
    "people/anna.md",
    "Anna asks about the NAS\nAnna fixes backups at the NAS",
    HATBOT,
    "c",
  );
  const hits = await mem.search("nas backups");
  expect([...new Set(hits.map((h) => h.path))]).toEqual(["people/anna.md", "homelab/backups.md"]);
  // The line with both words comes first in its file.
  expect(hits[0]).toMatchObject({ path: "people/anna.md", line: 2 });
  expect(await mem.search("   ")).toEqual([]);
});
