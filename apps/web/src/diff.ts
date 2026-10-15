// A line diff for proposals: what a file was and what it would become.

export type DiffLine = { kind: "add" | "del" | "same" | "gap"; text: string };

/** Lines kept around a change; longer runs of unchanged lines fold into a gap. */
const CONTEXT = 2;

/** The longest common subsequence of lines, then changes with a little context. */
export function lineDiff(before: string | null, after: string | null): DiffLine[] {
  const a = before === null ? [] : before.replace(/\n$/, "").split("\n");
  const b = after === null ? [] : after.replace(/\n$/, "").split("\n");
  // Huge files: whole-file replacement rather than a slow table.
  if (a.length * b.length > 4_000_000)
    return [
      ...a.map((text) => ({ kind: "del" as const, text })),
      ...b.map((text) => ({ kind: "add" as const, text })),
    ];
  const lcs = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      (lcs[i] as Uint32Array)[j] =
        a[i] === b[j]
          ? ((lcs[i + 1] as Uint32Array)[j + 1] as number) + 1
          : Math.max(
              (lcs[i + 1] as Uint32Array)[j] as number,
              (lcs[i] as Uint32Array)[j + 1] as number,
            );
  const all: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      all.push({ kind: "same", text: a[i] as string });
      i++;
      j++;
    } else if (
      i < a.length &&
      (j >= b.length ||
        ((lcs[i + 1] as Uint32Array)[j] as number) >= ((lcs[i] as Uint32Array)[j + 1] as number))
    ) {
      // What goes, before what replaces it.
      all.push({ kind: "del", text: a[i] as string });
      i++;
    } else {
      all.push({ kind: "add", text: b[j] as string });
      j++;
    }
  }
  // Keep unchanged lines near a change.
  const near = all.map((_, k) =>
    all.slice(Math.max(0, k - CONTEXT), k + CONTEXT + 1).some((l) => l.kind !== "same"),
  );
  const out: DiffLine[] = [];
  all.forEach((l, k) => {
    if (l.kind !== "same" || near[k]) out.push(l);
    else if (out.at(-1)?.kind !== "gap") out.push({ kind: "gap", text: "…" });
  });
  return out;
}
