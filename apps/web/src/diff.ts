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

/** The fewest lines deleted and added, with the unchanged start and end set aside first. */
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

/** Past this many lines deleted or added, the middle is shown as a whole replacement. */
const MOST_EDITS = 2_000;

/**
 * Myers' diff: its time grows with the file times the number of edits, not with the file squared, so
 * a few edits far apart in a long file are cheap.
 */
function middle(a: string[], b: string[]): DiffLine[] {
  const n = a.length;
  const m = b.length;
  // v[k + off] is how far along `a` the path on diagonal k (x - y) has got; one snapshot per step.
  const off = Math.min(n + m, MOST_EDITS) + 1;
  const v = new Int32Array(2 * off + 1);
  const trace: Int32Array[] = [];
  let edits = -1;
  for (let d = 0; d <= Math.min(n + m, MOST_EDITS) && edits < 0; d++) {
    for (let k = -d; k <= d; k += 2) {
      // Down from k + 1 is an added line, right from k - 1 a deleted one; on a tie, the deletion.
      let x =
        k === -d || (k !== d && (v[off + k - 1] as number) < (v[off + k + 1] as number))
          ? (v[off + k + 1] as number)
          : (v[off + k - 1] as number) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) {
        edits = d;
        break;
      }
    }
    trace.push(v.slice(off - d, off + d + 1));
  }
  // A huge rewrite: whole replacement rather than a slow search.
  if (edits < 0)
    return [
      ...a.map((text) => ({ kind: "del" as const, text })),
      ...b.map((text) => ({ kind: "add" as const, text })),
    ];
  // Back from the end, step by step.
  const all: DiffLine[] = [];
  let x = n;
  let y = m;
  for (let d = edits; d > 0; d--) {
    const prev = trace[d - 1] as Int32Array;
    const at = (k: number) => prev[k + d - 1] as number;
    const k = x - y;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const px = down ? at(k + 1) : at(k - 1);
    const py = px - (down ? k + 1 : k - 1);
    // The unchanged run after this step's edit, then the edit.
    while (x > (down ? px : px + 1)) {
      x--;
      all.push({ kind: "same", text: a[x] as string });
    }
    all.push(
      down ? { kind: "add", text: b[py] as string } : { kind: "del", text: a[px] as string },
    );
    x = px;
    y = py;
  }
  while (x > 0) {
    x--;
    all.push({ kind: "same", text: a[x] as string });
  }
  all.reverse();
  // What goes, before what replaces it.
  for (let s = 0; s < all.length; ) {
    if (all[s]?.kind === "same") {
      s++;
      continue;
    }
    let e = s;
    while (e < all.length && all[e]?.kind !== "same") e++;
    const run = all.slice(s, e);
    all.splice(
      s,
      e - s,
      ...run.filter((l) => l.kind === "del"),
      ...run.filter((l) => l.kind === "add"),
    );
    s = e;
  }
  return all;
}
