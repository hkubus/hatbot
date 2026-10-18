import { expect, test } from "bun:test";
import { installDom } from "./dom";

installDom();
const { afterSave, refill, toggled } = await import("../src/form");

type F = { name: string; members: string[] };
const saved: F = { name: "Kitchen", members: ["hatbot", "chef"] };
const clean = (f: F) => ({ form: f, base: f, seen: f });

test("a change saved elsewhere comes into the form only while you haven't edited it", () => {
  expect(refill<F>({}, saved)).toEqual(saved);
  // The store hands out a new object on every socket update; the values are what count.
  expect(refill<F>(clean(saved), { ...saved, members: [...saved.members] })).toBeNull();
  const elsewhere = { ...saved, members: ["hatbot"] };
  expect(refill<F>(clean(saved), elsewhere)).toEqual(elsewhere);
  const typing = { ...clean(saved), form: { ...saved, name: "Kitchen and pantry" } };
  expect(refill<F>(typing, elsewhere)).toBeNull();
});

test("what you type while Save is on its way stays, and still counts as unsaved", () => {
  const sent = { ...saved, name: "Pantry " };
  const back = { ...saved, name: "Pantry" };
  // Nothing typed since: the form is what was saved, clean.
  expect(afterSave<F>({ ...clean(saved), form: sent }, sent, back)).toEqual(clean(back));
  // More typed: it stays, against what was saved.
  const more = { ...sent, name: "Pantry and larder" };
  const after = afterSave<F>({ ...clean(saved), form: more }, sent, back);
  expect(after).toEqual({ form: more, base: back, seen: back });
  // The store's copy of the save then doesn't replace it.
  expect(refill<F>(after, back)).toBeNull();
});

test("switching one off and on again leaves the list as it was", () => {
  const all = ["hatbot", "chef", "haggler"];
  const off = toggled(["chef", "hatbot"], "chef", false, ["chef", "hatbot"], all);
  expect(off).toEqual(["hatbot"]);
  expect(toggled(off, "chef", true, ["chef", "hatbot"], all)).toEqual(["chef", "hatbot"]);
});
