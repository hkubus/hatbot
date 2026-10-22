import type { SpendDay } from "@hatbot/shared";
import { usd } from "./format";

/** A tick step from 1/2/5 × 10^n that gives about five gridlines. */
function niceStep(max: number) {
  const raw = max / 5;
  const pow = 10 ** Math.floor(Math.log10(raw));
  return ([1, 2, 5, 10].find((m) => m * pow >= raw) ?? 10) * pow;
}

/** `limit` is drawn only when it falls inside the range, so it doesn't squash ordinary days. */
export function spendAxis(values: number[], limit?: number) {
  const top = Math.max(...values, 0.05);
  const step = niceStep(top);
  const max = Number((Math.ceil(top / step - 1e-9) * step).toPrecision(12));
  const ticks = Array.from({ length: Math.round(max / step) + 1 }, (_, i) =>
    Number((i * step).toPrecision(12)),
  );
  const tick = (t: number) => (step >= 1 ? `$${t}` : usd(t));
  const showLimit = limit !== undefined && limit > 0 && limit <= max;
  return { max, ticks, tick, showLimit };
}

export function withToday(days: SpendDay[], today: SpendDay[]): SpendDay[] {
  const t = today[0];
  const last = days.at(-1);
  if (!t || !last) return days;
  if (last.date === t.date) return [...days.slice(0, -1), t];
  // Midnight passed since the 30 days were read: the oldest drops off.
  if (last.date < t.date) return [...days.slice(1), t];
  return days;
}
