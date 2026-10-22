// Never cut through a surrogate pair: half of one is invalid UTF-8, which Swift's JSONDecoder refuses
// (the whole event with it) and SQLite stores as U+FFFD.
export function head(text: string, n: number): string {
  if (text.length <= n) return text;
  const last = text.charCodeAt(n - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? n - 1 : n);
}

export function clip(text: string, max: number): string {
  return text.length > max ? `${head(text, max - 1)}…` : text;
}
