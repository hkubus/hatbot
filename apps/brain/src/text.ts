// Cutting text to a length counted in UTF-16 units, as JavaScript counts, without cutting through a
// character outside the BMP: half of one is invalid UTF-8, which Swift's JSONDecoder refuses (the whole
// event with it) and SQLite stores as U+FFFD.

/** The first `n` units of `text`, one fewer if the last would be the first half of a pair. */
export function head(text: string, n: number): string {
  if (text.length <= n) return text;
  const last = text.charCodeAt(n - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? n - 1 : n);
}

/** `text` in at most `max` units, ending in "…" if it's cut. */
export function clip(text: string, max: number): string {
  return text.length > max ? `${head(text, max - 1)}…` : text;
}
