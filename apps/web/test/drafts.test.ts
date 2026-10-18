import { expect, test } from "bun:test";
import { installDom } from "./dom";

installDom();

const { clearDrafts, draftFiles, draftText, saveDraftText, setDraftFiles } = await import(
  "../src/drafts"
);

test("signing out forgets every chat's draft, and nothing else in the browser", () => {
  localStorage.setItem("hatbot-theme", "dark");
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
  expect(localStorage.length).toBe(1);
  expect(localStorage.getItem("hatbot-theme")).toBe("dark");
});
