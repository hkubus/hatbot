import { expect, test } from "bun:test";
import { installDom } from "./dom";

installDom();
const { follows } = await import("../src/pages/Chat");

test("the thread stops following on any scroll up, and starts again only at the bottom", () => {
  // Following, and a reply streams: a few pixels up to read stops it.
  expect(follows(true, 1000, 997, 40)).toBe(false);
  // Down again, but not all the way: still not following.
  expect(follows(false, 997, 1020, 17)).toBe(false);
  // At the bottom: following again.
  expect(follows(false, 1020, 1037, 0)).toBe(true);
  // Pinned down as the reply grows: still following.
  expect(follows(true, 1037, 1300, 0)).toBe(true);
  // A smooth scroll to the bottom on its way there keeps following.
  expect(follows(true, 200, 600, 700)).toBe(true);
  // The view grew and the browser moved it up to the new bottom: still following.
  expect(follows(true, 1300, 1200, 0)).toBe(true);
});
