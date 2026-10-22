// Input timed and shaped like a person's: the pointer travels a slight curve, speeding up and
// slowing down, and keys come at an uneven pace. Sites that score visitors read both.

export type Point = { x: number; y: number };

const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

/** The points between `from` and `to`, ending exactly on `to`; none when they're the same. */
export function path(from: Point, to: Point, rand: () => number = Math.random): Point[] {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 1) return [];
  const steps = Math.max(4, Math.min(30, Math.round(dist / 25)));
  // Two control points pushed off the straight line to one side, so the path bows.
  const bow = (rand() < 0.5 ? -1 : 1) * dist * (0.05 + rand() * 0.15);
  const nx = -dy / dist;
  const ny = dx / dist;
  const c1 = { x: from.x + dx * 0.3 + nx * bow, y: from.y + dy * 0.3 + ny * bow };
  const c2 = { x: from.x + dx * 0.7 + nx * bow * 0.6, y: from.y + dy * 0.7 + ny * bow * 0.6 };
  const out: Point[] = [];
  for (let i = 1; i < steps; i++) {
    const t = easeInOut(i / steps);
    const u = 1 - t;
    const x = u ** 3 * from.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t ** 3 * to.x;
    const y = u ** 3 * from.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t ** 3 * to.y;
    const p = { x: Math.round(x), y: Math.round(y) };
    const last = out.at(-1);
    if (!last || last.x !== p.x || last.y !== p.y) out.push(p);
  }
  out.push({ x: Math.round(to.x), y: Math.round(to.y) });
  return out;
}

export const between = (min: number, max: number, rand: () => number = Math.random) =>
  Math.round(min + rand() * (max - min));

/** The gap before the next key: mostly quick, now and then a pause as if thinking. */
export const keyGap = (rand: () => number = Math.random) =>
  rand() < 0.05 ? between(180, 400, rand) : between(35, 110, rand);
