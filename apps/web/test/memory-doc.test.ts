import { expect, test } from "bun:test";
import { type Doc, isDirty, loading, newDoc, readDoc, readFailed } from "../src/memory-doc";

const ready = (path: string, content: string, sha = "a1"): Doc => ({
  path,
  content,
  saved: content,
  baseSha: sha,
  state: "ready",
});

test("a draft stays with its own file: another file's text never lands in it", () => {
  const draft = { ...ready("notes.md", "old"), content: "my draft" };
  // A late answer for another file doesn't touch it.
  expect(readDoc(draft, "INDEX.md", { content: "index", sha: "b2" })).toBe(draft);
  // Opening another file starts from that file, with its own version.
  expect(readDoc(loading("INDEX.md"), "INDEX.md", { content: "index", sha: "b2" })).toEqual(
    ready("INDEX.md", "index", "b2"),
  );
});

test("a refresh keeps your edits, and catches their version up after your own save", () => {
  const typing = { ...ready("notes.md", "v1", "s1"), content: "v1 and more" };
  // Someone else changed it: your edits and version stay, so Save meets the conflict.
  expect(readDoc(typing, "notes.md", { content: "theirs", sha: "s9" })).toBe(typing);
  // Your save came back: same text as you saved, newer version.
  const savedThen = { ...typing, saved: "v1 and more" };
  const typingMore = { ...savedThen, content: "v1 and more and more" };
  expect(readDoc(typingMore, "notes.md", { content: "v1 and more", sha: "s2" })).toMatchObject({
    content: "v1 and more and more",
    baseSha: "s2",
  });
  // Nothing edited: it simply follows the file.
  expect(readDoc(ready("notes.md", "v1"), "notes.md", { content: "v2", sha: "s3" })).toEqual(
    ready("notes.md", "v2", "s3"),
  );
});

test("a file that couldn't be read can't be saved over", () => {
  const failed = readFailed(loading("notes.md"), "notes.md", false, "Can't reach Hatbot.");
  expect(failed).toMatchObject({ state: "failed", error: "Can't reach Hatbot." });
  expect(isDirty(failed)).toBe(false);
  // A refresh that fails keeps the file shown.
  const shown = ready("notes.md", "v1");
  expect(readFailed(shown, "notes.md", false, "x")).toBe(shown);
});

test("a file that isn't there opens empty, as a new one", () => {
  const d = readFailed(loading("bots/chef/INDEX.md"), "bots/chef/INDEX.md", true, "not found");
  expect(d).toMatchObject({ state: "new", content: "", baseSha: "" });
  expect(isDirty(d)).toBe(false);
});

test("New file starts with a heading and counts as unsaved", () => {
  const d = newDoc("projects/garden-plan.md");
  expect(d.content).toBe("# Garden plan\n");
  expect(d.baseSha).toBe("");
  expect(isDirty(d)).toBe(true);
});
