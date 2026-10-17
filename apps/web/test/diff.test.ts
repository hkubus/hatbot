import { describe, expect, test } from "bun:test";
import { lineDiff } from "../src/diff";

const lines = (n: number, from = 1) => Array.from({ length: n }, (_, i) => `line ${i + from}`);

describe("lineDiff", () => {
  test("a new file is all added, a deleted one all gone", () => {
    expect(lineDiff(null, "a\nb\n")).toEqual([
      { kind: "add", text: "a" },
      { kind: "add", text: "b" },
    ]);
    expect(lineDiff("a\nb", null)).toEqual([
      { kind: "del", text: "a" },
      { kind: "del", text: "b" },
    ]);
  });

  test("a change keeps two lines around it and folds the rest", () => {
    const before = lines(10);
    const after = [...before];
    after[4] = "changed";
    expect(lineDiff(before.join("\n"), after.join("\n"))).toEqual([
      { kind: "gap", text: "…" },
      { kind: "same", text: "line 3" },
      { kind: "same", text: "line 4" },
      { kind: "del", text: "line 5" },
      { kind: "add", text: "changed" },
      { kind: "same", text: "line 6" },
      { kind: "same", text: "line 7" },
      { kind: "gap", text: "…" },
    ]);
  });

  test("lines added at the start and end", () => {
    expect(lineDiff("b\nc", "a\nb\nc\nd")).toEqual([
      { kind: "add", text: "a" },
      { kind: "same", text: "b" },
      { kind: "same", text: "c" },
      { kind: "add", text: "d" },
    ]);
  });

  test("moved and repeated lines still line up", () => {
    expect(lineDiff("x\na\nb\na\ny", "x\nb\na\nb\ny")).toEqual([
      { kind: "same", text: "x" },
      { kind: "del", text: "a" },
      { kind: "same", text: "b" },
      { kind: "same", text: "a" },
      { kind: "add", text: "b" },
      { kind: "same", text: "y" },
    ]);
  });

  test("one line changed in a 20,000-line file is one line, not the whole file", () => {
    const before = lines(20_000);
    const after = [...before];
    after[12_345] = "changed";
    const d = lineDiff(before.join("\n"), after.join("\n"));
    expect(d.filter((l) => l.kind === "del")).toEqual([{ kind: "del", text: "line 12346" }]);
    expect(d.filter((l) => l.kind === "add")).toEqual([{ kind: "add", text: "changed" }]);
    expect(d).toHaveLength(8);
  });

  test("the same diff again is the same answer, not worked out again", () => {
    const before = lines(50).join("\n");
    const after = lines(51).join("\n");
    expect(lineDiff(before, after)).toBe(lineDiff(before, after));
    expect(lineDiff(before, `${after}\nmore`)).not.toBe(lineDiff(before, after));
  });
});
