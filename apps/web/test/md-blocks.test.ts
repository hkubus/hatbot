import { expect, test } from "bun:test";
import { splitBlocks } from "../src/md-blocks";

test("a streaming reply splits at blank lines into finished blocks and the one growing", () => {
  expect(splitBlocks("One.\n\nTwo, still")).toEqual(["One.", "Two, still"]);
  // Not yet: the line after the blank one hasn't started.
  expect(splitBlocks("One.\n\n")).toEqual(["One.\n\n"]);
  // Indented after a blank line: it may still belong to a list item.
  expect(splitBlocks("1. Step\n\n   More on it")).toEqual(["1. Step\n\n   More on it"]);
  // A code fence keeps its blank lines, even before it's closed.
  const code = "Run:\n\n```sh\necho a\n\necho b\n```\n\nDone";
  expect(splitBlocks(code)).toEqual(["Run:", "```sh\necho a\n\necho b\n```", "Done"]);
  expect(splitBlocks("```\na\n\nb")).toEqual(["```\na\n\nb"]);
  // Closed only by the same character, at least as many, and nothing after.
  expect(splitBlocks("````\n```\n\nx\n````\n\ny")).toEqual(["````\n```\n\nx\n````", "y"]);
  expect(splitBlocks("~~~\n```\n\nx")).toEqual(["~~~\n```\n\nx"]);
});

test("finished blocks don't change as the reply grows, so each is parsed once", () => {
  const reply =
    "# Title\n\nFirst paragraph.\n\n- a\n- b\n\n```js\nlet x = 1;\n\nx++;\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nLast.";
  let finished: string[] = [];
  for (let n = 1; n <= reply.length; n++) {
    const blocks = splitBlocks(reply.slice(0, n));
    const done = blocks.slice(0, -1);
    expect(done.slice(0, finished.length)).toEqual(finished);
    finished = done;
    // Nothing is lost or added but the blank lines between blocks.
    expect(blocks.join("\n\n")).toBe(reply.slice(0, n));
  }
  expect(finished).toHaveLength(5);
});
