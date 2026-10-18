import { expect, test } from "bun:test";
import { type Doc, isDirty, loading, readDoc, readFailed } from "../src/memory-doc";

const ready = (path: string, content: string, sha = "a1"): Doc => ({
  path,
  content,
  saved: content,
  baseSha: sha,
  state: "ready",
});

test("a read never replaces your draft, and catches its version up after your own save", () => {
  const typing = { ...ready("notes.md", "v1", "s1"), content: "v1 and more" };
  // A late answer for another file.
  expect(readDoc(typing, "INDEX.md", { content: "index", sha: "b2" })).toBe(typing);
  // Someone else changed it: your edits and version stay, so Save meets the conflict.
  expect(readDoc(typing, "notes.md", { content: "theirs", sha: "s9" })).toBe(typing);
  // Your save came back: same text as you saved, newer version.
  const typingMore = { ...typing, saved: "v1 and more", content: "v1 and more and more" };
  expect(readDoc(typingMore, "notes.md", { content: "v1 and more", sha: "s2" })).toMatchObject({
    content: "v1 and more and more",
    baseSha: "s2",
  });
  // Nothing edited: it simply follows the file.
  expect(readDoc(ready("notes.md", "v1"), "notes.md", { content: "v2", sha: "s3" })).toEqual(
    ready("notes.md", "v2", "s3"),
  );
});

test("a file that couldn't be read can't be saved over; one that isn't there opens as new", () => {
  const failed = readFailed(loading("notes.md"), "notes.md", false, "Can't reach Hatbot.");
  expect(failed).toMatchObject({ state: "failed", error: "Can't reach Hatbot." });
  expect(isDirty(failed)).toBe(false);
  // A refresh that fails keeps the file shown.
  const shown = ready("notes.md", "v1");
  expect(readFailed(shown, "notes.md", false, "x")).toBe(shown);
  const missing = readFailed(loading("chef.md"), "chef.md", true, "not found");
  expect(missing).toMatchObject({ state: "new", content: "", baseSha: "" });
});
