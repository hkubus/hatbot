const pad = (n: number) => String(n).padStart(2, "0");

export function localInput(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * A datetime-local value as the moment it means here, for the brain: without an offset the brain
 * would read it in its own time zone, and a once-off would run at another hour than the one shown.
 */
export function atIso(local: string): string {
  const d = new Date(local);
  return local && !Number.isNaN(d.getTime()) ? d.toISOString() : "";
}

const NICKNAMES = /^@(yearly|annually|monthly|weekly|daily|midnight|hourly)$/i;
const RANGES: [number, number][] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function fieldValue(v: string, field: number): number | null {
  const names = field === 3 ? MONTHS : field === 4 ? DAYS : [];
  const named = names.indexOf(v.toLowerCase());
  if (named >= 0) return named + (field === 3 ? 1 : 0);
  const [lo, hi] = RANGES[field] as [number, number];
  return /^\d{1,2}$/.test(v) && Number(v) >= lo && Number(v) <= hi ? Number(v) : null;
}

function partOk(part: string, field: number): boolean {
  const [range = "", step, ...rest] = part.split("/");
  if (rest.length || (step !== undefined && !/^[1-9]\d*$/.test(step))) return false;
  if (range === "*" || range === "?") return true;
  // croner's last day, nearest weekday and nth weekday.
  if (field === 2 && /^(L|LW|\d{1,2}W)$/i.test(range)) return true;
  if (field === 4 && /^([0-7]|[a-z]{3})(#[1-5]|L)$/i.test(range)) return true;
  const ends = range.split("-").map((e) => fieldValue(e, field));
  if (ends.length > 2 || ends.some((e) => e === null)) return false;
  return ends.length === 1 || (ends[0] as number) <= (ends[1] as number);
}

export function cronOk(expr: string): boolean {
  const t = expr.trim();
  if (NICKNAMES.test(t)) return true;
  const fields = t.split(/\s+/);
  return (
    fields.length === 5 && fields.every((f, i) => f.split(",").every((part) => partOk(part, i)))
  );
}
