import { expect, test } from "bun:test";
import { spendAxis } from "../src/spend";

test("the spend axis scales to the days, and shows the limit only once a day comes near it", () => {
  const low = spendAxis([0.2, 0.31, 0.12], 5);
  expect([low.max, low.showLimit]).toEqual([0.4, false]);
  expect(low.ticks.map(low.tick)).toEqual(["$0.00", "$0.10", "$0.20", "$0.30", "$0.40"]);
  const near = spendAxis([1, 4.6, 2], 5);
  expect([near.max, near.showLimit]).toEqual([5, true]);
  // Nothing spent yet: still an axis, a few cents high.
  expect(spendAxis([0, 0, 0]).max).toBe(0.05);
});
