import { expect, test } from "bun:test";
import { splitBlocks } from "../src/md-blocks";

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
  // The code block's blank line doesn't end it.
  expect(finished).toHaveLength(5);
});
