import { expect, test } from "bun:test";
import { installDom, settle } from "./dom";

const b = installDom("/memory");
// Its own copy of the router: it listens on the window that's there as it loads, and the files run
// before this one load theirs under another.
const { navigate, setLeaveGuard } = await import("../src/router.ts?router-test");

// What the routes hear: they listen after the router does.
const heard: string[] = [];
b.window.addEventListener("popstate", () => heard.push(b.url()));

/** A guard you answer later. */
function guard() {
  let answer: (go: boolean) => void = () => {};
  let asked = 0;
  const off = setLeaveGuard(() => {
    asked++;
    return new Promise<boolean>((r) => {
      answer = r;
    });
  });
  return { answer: (go: boolean) => answer(go), asked: () => asked, off };
}

test("navigate goes at once, or with a guard waits for the answer: no stays, yes goes", async () => {
  navigate("/tasks");
  expect(b.url()).toBe("/tasks");
  expect(heard.at(-1)).toBe("/tasks");
  const g = guard();
  navigate("/settings");
  expect(g.asked()).toBe(1);
  expect(b.url()).toBe("/tasks");
  g.answer(false);
  await settle();
  expect(b.url()).toBe("/tasks");

  navigate("/settings");
  g.answer(true);
  await settle();
  expect(b.url()).toBe("/settings");
  expect(heard.at(-1)).toBe("/settings");
  g.off();
  // The same address isn't leaving.
  const again = guard();
  navigate("/settings");
  expect(again.asked()).toBe(0);
  again.off();
});

test("Back with a guard keeps the page while it asks, and goes back on yes", async () => {
  const g = guard();
  const before = heard.length;
  b.history.back();
  await settle();
  // The address is put back and the routes hear nothing.
  expect(g.asked()).toBe(1);
  expect(b.url()).toBe("/settings");
  expect(heard.length).toBe(before);
  g.answer(false);
  await settle();
  expect(b.url()).toBe("/settings");

  b.history.back();
  await settle();
  expect(g.asked()).toBe(2);
  g.answer(true);
  await settle();
  expect(b.url()).toBe("/tasks");
  expect(heard.at(-1)).toBe("/tasks");
  // Forward is where you were.
  expect(b.entries().at(-1)).toBe("/settings");
  g.off();
});
