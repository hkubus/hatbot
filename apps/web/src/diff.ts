// A line diff for proposals: what a file was and what it would become.

export type DiffLine = { kind: "add" | "del" | "same" | "gap"; text: string };

/** Lines kept around a change; longer runs of unchanged lines fold into a gap. */
const CONTEXT = 2;

/** The last diff of each `before`: a proposal's page draws its diffs again on every render. */
const recent = new Map<string | null, { after: string | null; lines: DiffLine[] }>();

/** The changes from `before` to `after` with a little context; the same answer again is cached. */
export function lineDiff(before: string | null, after: string | null): DiffLine[] {
  const hit = recent.get(before);
  if (hit && hit.after === after) return hit.lines;
  const lines = diff(before, after);
  if (recent.size >= 32) recent.clear();
  recent.set(before, { after, lines });
  return lines;
}

/** The longest common subsequence of the lines between the unchanged start and end. */
function diff(before: string | null, after: string | null): DiffLine[] {
  const a = before === null ? [] : before.replace(/\n$/, "").split("\n");
  const b = after === null ? [] : after.replace(/\n$/, "").split("\n");
  // Most edits touch a few lines: what's the same at the start and end needs no table.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (
    end < a.length - start &&
    end < b.length - start &&
    a[a.length - 1 - end] === b[b.length - 1 - end]
  )
    end++;
  const same = (text: string) => ({ kind: "same" as const, text });
  const all: DiffLine[] = [
    ...a.slice(0, start).map(same),
    ...middle(a.slice(start, a.length - end), b.slice(start, b.length - end)),
    ...a.slice(a.length - end).map(same),
  ];
  // Keep unchanged lines near a change.
  const near = new Array<boolean>(all.length).fill(false);
  all.forEach((l, k) => {
    if (l.kind === "same") return;
    for (let n = Math.max(0, k - CONTEXT); n <= Math.min(all.length - 1, k + CONTEXT); n++)
      near[n] = true;
  });
  const out: DiffLine[] = [];
  all.forEach((l, k) => {
    if (l.kind !== "same" || near[k]) out.push(l);
    else if (out.at(-1)?.kind !== "gap") out.push({ kind: "gap", text: "…" });
  });
  return out;
}

function middle(a: string[], b: string[]): DiffLine[] {
  // A huge rewrite: whole replacement rather than a slow table.
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
  return all;
}
