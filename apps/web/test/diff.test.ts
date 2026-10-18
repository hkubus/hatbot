import { describe, expect, test } from "bun:test";
import { lineDiff } from "../src/diff";

const lines = (n: number, from = 1) => Array.from({ length: n }, (_, i) => `line ${i + from}`);

describe("lineDiff", () => {
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

  test("two edits 3,000 lines apart in a long file are two edits, not the whole file", () => {
    const before = lines(20_000);
    const after = [...before];
    after[50] = "changed top";
    after[3_050] = "changed bottom";
    const d = lineDiff(before.join("\n"), after.join("\n"));
    expect(d.filter((l) => l.kind === "del")).toEqual([
      { kind: "del", text: "line 51" },
      { kind: "del", text: "line 3051" },
    ]);
    expect(d.filter((l) => l.kind === "add")).toEqual([
      { kind: "add", text: "changed top" },
      { kind: "add", text: "changed bottom" },
    ]);
  });

  test("a rewrite too big to work out is shown whole", () => {
    const before = lines(3_000);
    const after = lines(3_000, 5_000);
    const d = lineDiff(before.join("\n"), after.join("\n"));
    expect(d.filter((l) => l.kind === "del")).toHaveLength(3_000);
    expect(d.filter((l) => l.kind === "add")).toHaveLength(3_000);
    expect(d[0]).toEqual({ kind: "del", text: "line 1" });
  });
});
