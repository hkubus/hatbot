import { expect, test } from "bun:test";
import { refill } from "../src/form";

type F = { name: string; members: string[] };
const saved: F = { name: "Kitchen", members: ["hatbot", "chef"] };
const clean = (f: F) => ({ form: f, base: f, seen: f });

test("a form is filled once its item loads", () => {
  expect(refill<F>({}, undefined)).toBeNull();
  expect(refill<F>({}, saved)).toEqual(saved);
});

test("a new copy of the same item doesn't touch the form", () => {
  // The store hands out a new object on every socket update; the values are what count.
  const typing = { ...clean(saved), form: { ...saved, name: "Kitch" } };
  expect(refill<F>(typing, { ...saved })).toBeNull();
  expect(refill<F>(clean(saved), { ...saved, members: [...saved.members] })).toBeNull();
});

test("a change saved elsewhere comes in while you haven't edited", () => {
  const renamed = { ...saved, name: "Galley" };
  expect(refill<F>(clean(saved), renamed)).toEqual(renamed);
});

test("a change saved elsewhere waits while you're editing, and comes in once you undo", () => {
  const typing = { ...clean(saved), form: { ...saved, name: "Kitchen and pantry" } };
  const elsewhere = { ...saved, members: ["hatbot"] };
  expect(refill<F>(typing, elsewhere)).toBeNull();
  expect(refill<F>(clean(saved), elsewhere)).toEqual(elsewhere);
});

test("your own save coming back makes the form clean again", () => {
  const typing = { ...clean(saved), form: { ...saved, name: "Pantry" } };
  expect(refill<F>(typing, { ...saved, name: "Pantry" })).toEqual({ ...saved, name: "Pantry" });
});

test("a form filled from a template stays filled while the stored values don't change", () => {
  const empty: F = { name: "", members: [] };
  const template: F = { name: "Haggler", members: ["mcp"] };
  expect(refill<F>({ form: template, base: template, seen: empty }, empty)).toBeNull();
});
