// The six boxes of a one-time code, as one string with a space for each empty box: a digit fixed
// in one box never moves the others.

export const slots = (code: string) => Array.from({ length: 6 }, (_, i) => (code[i] ?? " ").trim());
const join = (s: string[]) => s.map((d) => d || " ").join("");

type Step = { code: string; focus: number };

/** Digits pasted (or autofilled) into box `i`: a whole code fills every box, a part fills from `i`. */
export function pasted(code: string, i: number, text: string): Step {
  const digits = text.replace(/\D/g, "");
  if (digits.length >= 6) return { code: digits.slice(0, 6), focus: 5 };
  const s = slots(code);
  for (const [k, d] of [...digits].entries()) if (i + k < 6) s[i + k] = d;
  return { code: join(s), focus: Math.min(5, i + digits.length) };
}

/** Box `i` now reads `raw`: only the digit just typed goes in, and only into that box. */
export function typed(code: string, i: number, raw: string): Step {
  const digits = raw.replace(/\D/g, "");
  // The phone's one-time code from a text comes as a change, not a paste.
  if (digits.length > 2) return pasted(code, i, digits);
  const s = slots(code);
  const old = s[i] ?? "";
  // Something that isn't a digit: nothing changes.
  if (/\D/.test(raw) && digits === old) return { code: join(s), focus: i };
  // Typed into a full box, with the caret before or after the digit that was there.
  const d = digits.length === 2 ? (digits[0] === old ? digits[1] : digits[0]) : digits;
  s[i] = d ?? "";
  return { code: join(s), focus: d ? Math.min(5, i + 1) : i };
}

/** Backspace in an empty box: the one before it is cleared, and has the focus. */
export function backspace(code: string, i: number): Step {
  if (i === 0) return { code, focus: 0 };
  const s = slots(code);
  s[i - 1] = "";
  return { code: join(s), focus: i - 1 };
}
