import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Db, openDb } from "../src/db";
import { blobSha, HATBOT, MemoryConflict, MemoryError, MemoryStore } from "../src/memory/store";
import { setUpOwner, testApp } from "./helpers";

const YOU = { name: "You", email: "owner@local" };
let dir: string;
let db: Db;
let mem: MemoryStore;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "hatbot-mem-"));
  db = openDb(":memory:");
  mem = new MemoryStore(dir, db);
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

test("search ranks sections by how well they match, finding words in any form", async () => {
  await mem.write(
    "homelab/scout.md",
    "# Scout\nScout runs on CT 130.\n\n## Backups\nPBS backs it up nightly.",
    HATBOT,
    "a",
  );
  await mem.write("homelab/nas.md", "# NAS\nThe NAS is a Synology and runs Docker.", HATBOT, "b");
  // Not every word has to be there, and the section with more of them comes first.
  expect(await mem.search("what runs scout")).toEqual([
    { path: "homelab/scout.md", line: 2, text: "Scout runs on CT 130." },
    { path: "homelab/nas.md", line: 2, text: "The NAS is a Synology and runs Docker." },
  ]);
  // Stemmed, and the last word is a prefix: "backing" finds "backs", "nightl" finds "nightly".
  expect(await mem.search("backing up nightl")).toEqual([
    { path: "homelab/scout.md", line: 5, text: "PBS backs it up nightly." },
  ]);
  expect(await mem.search("   ")).toEqual([]);
});

test("the search index follows every write, delete and revert, and hand edits at startup", async () => {
  const find = async (q: string) => (await mem.search(q)).map((h) => h.path);
  await mem.write("pets.md", "Mia is a cat", YOU, "pets");
  expect(await find("cat")).toEqual(["pets.md"]);
  await mem.write("pets.md", "Mia is a dog", YOU, "pets");
  expect(await find("cat")).toEqual([]);
  expect(await find("dog")).toEqual(["pets.md"]);
  const deleted = (await mem.delete("pets.md", YOU, "forget")) as string;
  expect(await find("dog")).toEqual([]);
  await mem.revert(deleted, YOU);
  expect(await find("dog")).toEqual(["pets.md"]);

  // Edited by hand outside Hatbot, then the brain starts.
  writeFileSync(join(dir, "hand.md"), "Typed on the brain directly\n");
  expect(await find("directly")).toEqual([]);
  await new MemoryStore(dir, db).init();
  expect(await find("directly")).toEqual(["hand.md"]);
});

test("without the index, or when it fails, search wants every word, in any line of a file", async () => {
  await mem.write("homelab/backups.md", "PBS backs up nightly\nThe NAS keeps backups", HATBOT, "a");
  await mem.write("homelab/nas.md", "The NAS is a Synology", HATBOT, "b");
  await mem.write(
    "people/anna.md",
    "Anna asks about the NAS\nAnna fixes backups at the NAS",
    HATBOT,
    "c",
  );
  const grep = new MemoryStore(dir);
  const hits = await grep.search("nas backups");
  expect([...new Set(hits.map((h) => h.path))]).toEqual(["people/anna.md", "homelab/backups.md"]);
  // The line with both words comes first in its file.
  expect(hits[0]).toMatchObject({ path: "people/anna.md", line: 2 });
  expect(await grep.search("   ")).toEqual([]);

  db.run("DROP TABLE memory_fts");
  expect(await mem.search("nas backups")).toEqual(hits);
});
