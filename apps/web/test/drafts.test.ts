import { expect, test } from "bun:test";

// The browser's storage, as far as drafts use it.
const stored = new Map<string, string>();
globalThis.localStorage = {
  get length() {
    return stored.size;
  },
  key: (i: number) => [...stored.keys()][i] ?? null,
  getItem: (k: string) => stored.get(k) ?? null,
  setItem: (k: string, v: string) => void stored.set(k, v),
  removeItem: (k: string) => void stored.delete(k),
  clear: () => stored.clear(),
} as Storage;

const { clearDrafts, draftFiles, draftText, saveDraftText, setDraftFiles } = await import(
  "../src/drafts"
);

test("signing out forgets every chat's draft, and nothing else in the browser", () => {
  stored.set("hatbot:theme", "dark");
  saveDraftText("1", "a note to Hatbot");
  saveDraftText("7", "to the Haggler");
  saveDraftText("1:incognito", "kept in memory only");
  const upload = new AbortController();
  setDraftFiles("7", () => [{ key: 1, name: "cat.png", abort: upload }]);
  expect(draftText("1")).toBe("a note to Hatbot");

  clearDrafts();
  expect(draftText("1")).toBe("");
  expect(draftText("7")).toBe("");
  expect(draftText("1:incognito")).toBe("");
  expect(draftFiles("7")).toEqual([]);
  expect(upload.signal.aborted).toBe(true);
  expect([...stored.keys()]).toEqual(["hatbot:theme"]);
});
