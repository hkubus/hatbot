import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCoreTool } from "../src/agent/tools";
import { openDb } from "../src/db";
import { EventBus } from "../src/events";
import { blobSha, HATBOT, MemoryError, MemoryStore } from "../src/memory/store";
import { signIn, testApp } from "./helpers";

const YOU = { name: "You", email: "owner@local" };
let dir: string;
let mem: MemoryStore;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "hatbot-mem-"));
  mem = new MemoryStore(dir, openDb(":memory:"));
  await mem.init();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("a change that fails puts the files back as they were", async () => {
  await mem.write("prefs.md", "tea", YOU, "prefs");
  const sha = (await mem.write("prefs.md", "coffee", YOU, "coffee")) as string;
  // A write of several files whose last can't be written: prefs.md is a file, not a folder.
  const half = mem.writeAll(
    [
      { path: "fresh.md", content: "fresh" },
      { path: "prefs.md", content: "milk" },
      { path: "prefs.md/oops.md", content: "x" },
    ],
    HATBOT,
    "half",
  );
  await expect(half).rejects.toThrow();
  expect(await mem.exists("fresh.md")).toBe(false);
  expect(await mem.read("prefs.md")).toBe("coffee\n");

  writeFileSync(join(dir, "prefs.md"), "green tea\n");
  const hook = join(dir, ".git", "hooks", "pre-commit");
  writeFileSync(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  await expect(mem.write("prefs.md", "milk", YOU, "milk")).rejects.toThrow();
  expect(await mem.read("prefs.md")).toBe("green tea\n");
  await expect(mem.delete("prefs.md", YOU, "forget")).rejects.toThrow();
  expect(await mem.read("prefs.md")).toBe("green tea\n");
  writeFileSync(join(dir, "prefs.md"), "coffee\n");
  await expect(mem.revert(sha, YOU)).rejects.toThrow();
  expect(await mem.read("prefs.md")).toBe("coffee\n");
  expect(await mem.uncommitted()).toEqual([]);
  rmSync(hook);
  await mem.write("other.md", "other", YOU, "other");
  expect((await mem.log(1))[0]?.files).toEqual(["other.md"]);
});

test("memory inside another repo that ignores it keeps its own", async () => {
  const outer = mkdtempSync(join(tmpdir(), "hatbot-outer-"));
  try {
    Bun.spawnSync(["git", "init", "-q"], { cwd: outer });
    writeFileSync(join(outer, ".gitignore"), "/data/\n");
    const inner = new MemoryStore(join(outer, "data", "memory"), openDb(":memory:"));
    await inner.init();
    await inner.write("prefs.md", "tea", YOU, "prefs");
    expect((await inner.log(1))[0]?.files).toEqual(["prefs.md"]);
  } finally {
    rmSync(outer, { recursive: true, force: true });
  }
});

test("a file made by hand and never committed can be deleted", async () => {
  writeFileSync(join(dir, "hand.md"), "by hand\n");
  expect(await mem.delete("hand.md", YOU, "Delete hand.md")).toBeNull();
  expect(await mem.exists("hand.md")).toBe(false);
});

test("a revert doesn't overwrite a file edited by hand", async () => {
  const sha = (await mem.write("prefs.md", "tea", YOU, "prefs")) as string;
  writeFileSync(join(dir, "prefs.md"), "green tea\n");
  await expect(mem.revert(sha, YOU)).rejects.toThrow("prefs.md has changes");
  expect(await mem.read("prefs.md")).toBe("green tea\n");
});

test("paths outside the repo, into .git, or not markdown are refused", async () => {
  for (const p of ["../x.md", "/etc/passwd", ".git/config", "a/../../x.md"])
    expect(() => mem.resolve(p)).toThrow(MemoryError);
  await expect(mem.write("x.sh", "echo", HATBOT, "x")).rejects.toThrow(MemoryError);
});

test("updates at once each read what the last wrote, so none is lost", async () => {
  await mem.write("notes.md", "# Notes", HATBOT, "Start notes");
  const add = (line: string) =>
    mem.update("notes.md", async (now) => `${now ?? ""}- ${line}\n`, HATBOT, `Add ${line}`);
  await Promise.all(["a", "b", "c", "d"].map(add));
  expect(await mem.read("notes.md")).toBe("# Notes\n- a\n- b\n- c\n- d\n");
});

test("a save on top of an older copy is refused with what the file is now", async () => {
  const t = await testApp();
  const { cookie } = signIn(t);
  await t.memory.write("a.md", "one", HATBOT, "One");
  const got = (await (
    await t.call("GET", "/memory/file?path=a.md", undefined, { cookie })
  ).json()) as { content: string; sha: string };
  const put = (path: string, content: string, baseSha: string) =>
    t.call("PUT", `/memory/file?path=${path}`, { content, baseSha }, { cookie });
  expect((await put("a.md", "two", got.sha)).status).toBe(200);
  const conflict = await put("a.md", "three", got.sha);
  expect(conflict.status).toBe(409);
  expect(await conflict.json()).toEqual({
    error: "changed",
    sha: blobSha("two\n"),
    content: "two\n",
  });
  // "" is a new file: refused once it exists.
  expect((await put("a.md", "x", "")).status).toBe(409);
  expect(await t.memory.read("a.md")).toBe("two\n");
  expect((await t.call("GET", "/memory/file?path=b.md", undefined, { cookie })).status).toBe(404);
});

test("memory_edit adds lines, making the file if it isn't there, and changes text found there once; otherwise nothing changes", async () => {
  const t = await testApp();
  const ctx = {
    db: t.db,
    memory: t.memory,
    events: new EventBus(),
    bot: t.bots.hatbot(),
    bots: t.bots,
  };
  const edit = (input: object) => runCoreTool("memory_edit", { path: "log.md", ...input }, ctx);
  expect((await edit({ append: "- 08:00 0%" })).isError).toBe(false);
  await t.memory.write("log.md", "# Log\n- 08:00 0%", HATBOT, "Log");
  await edit({ append: "- 08:15 2%\n- 08:30 0%" });
  expect(await t.memory.read("log.md")).toBe("# Log\n- 08:00 0%\n- 08:15 2%\n- 08:30 0%\n");
  await edit({ edits: [{ old: "- 08:00 0%\n", new: "" }], append: "- 08:45 1%" });
  expect(await t.memory.read("log.md")).toBe("# Log\n- 08:15 2%\n- 08:30 0%\n- 08:45 1%\n");

  for (const old of ["%", "- 09:00"]) {
    const r = await edit({
      edits: [
        { old: "# Log", new: "# Loss" },
        { old, new: "x" },
      ],
    });
    expect(r.isError).toBe(true);
  }
  expect((await edit({})).content).toContain("Nothing to change");
  expect(
    (await runCoreTool("memory_edit", { path: "new.md", edits: [{ old: "a", new: "b" }] }, ctx))
      .isError,
  ).toBe(true);
  expect(await t.memory.read("log.md")).toBe("# Log\n- 08:15 2%\n- 08:30 0%\n- 08:45 1%\n");
});

test("memory_write makes a file or rewrites a short one, but a long one only through memory_edit", async () => {
  const t = await testApp();
  const ctx = { db: t.db, memory: t.memory, events: new EventBus(), bot: t.bots.hatbot() };
  const write = (path: string, content: string) =>
    runCoreTool("memory_write", { path, content }, ctx);
  expect((await write("notes/new.md", "# New\n")).isError).toBe(false);
  expect((await write("notes/new.md", "# New, again\n")).isError).toBe(false);
  const report = `# Report\n${"A finding.\n".repeat(1000)}`;
  await t.memory.write("notes/report.md", report, HATBOT, "Report");
  expect((await write("notes/report.md", "# Report\nShorter.\n")).isError).toBe(true);
  expect(await t.memory.read("notes/report.md")).toBe(report);
});
