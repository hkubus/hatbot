/** Dollars to the cent; a cost under half a cent shows as "<$0.01", not "$0.00". */
export const usd = (v: number) => (v > 0 && v < 0.005 ? "<$0.01" : `$${v.toFixed(2)}`);

/** "08:05". */
export const time = (iso: string) =>
  new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

/** "11 Oct". */
export const day = (date: string | Date) =>
  new Date(date).toLocaleDateString("en-GB", { day: "numeric", month: "short" });

/** "Sat 11 Oct". */
export const weekday = (date: string | Date) =>
  new Date(date).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });

/** A YYYY-MM-DD date, at noon local time: on its own it would be read as UTC. */
export function dateOnly(date: string): Date {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d, 12);
}

const today = (iso: string) => new Date(iso).toDateString() === new Date().toDateString();

/** "08:05" today, "11 Oct" this year, else "11 Oct 2025". The time a task started, in lists. */
export const timeOrDay = (iso: string) =>
  today(iso)
    ? time(iso)
    : new Date(iso).getFullYear() === new Date().getFullYear()
      ? day(iso)
      : new Date(iso).toLocaleDateString("en-GB", {
          day: "numeric",
          month: "short",
          year: "numeric",
        });

/** "11 Oct, 08:05". */
export const dayTime = (iso: string) => `${day(iso)}, ${time(iso)}`;

/** "08:05" today, else "11 Oct, 08:05". */
export const shortStamp = (iso: string) => (today(iso) ? time(iso) : dayTime(iso));

/** "Sat 11 Oct, 08:05". */
export const stamp = (iso: string) =>
  new Date(iso).toLocaleString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

/** 950, 12.4k, 3.1M. */
export const tokens = (n: number) =>
  n < 1000
    ? String(n)
    : n < 1_000_000
      ? `${(n / 1000).toFixed(1)}k`
      : `${(n / 1_000_000).toFixed(1)}M`;

/** A commit as git shows it short. */
export const shortSha = (sha?: string | null) => sha?.slice(0, 7) ?? "";

/** Forgejo's merge commits wrap the pull request's title; just the title. */
export const prTitle = (subject: string) =>
  /^Merge pull request '(.+)' \(#\d+\) from \S+ into \S+$/.exec(subject)?.[1] ?? subject;

/** Worked out from the id so a new model has a name too. */
export function modelName(id: string): string {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(id);
  if (!m) return id;
  const [, family = "", major, minor] = m;
  return `${family.charAt(0).toUpperCase()}${family.slice(1)} ${major}${minor ? `.${minor}` : ""}`;
}

/** Search's match marks pass through. */
export function plainText(md: string): string {
  return (
    md
      // Code fences, rules, and table rules: whole lines of marks.
      .replace(/^[ \t]*(```|~~~).*$/gm, "")
      .replace(/^[ \t]*([-*_])([ \t]*\1){2,}[ \t]*$/gm, "")
      .replace(/^[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(\|[ \t]*:?-{3,}:?[ \t]*)*\|?[ \t]*$/gm, "")
      // Headings, quotes, list items and task boxes, nested or not.
      .replace(/^[ \t]*(?:#{1,6}[ \t]+|>[ \t]?|[-*+][ \t]+|\d+[.)][ \t]+|\[[ xX]\][ \t]+)+/gm, "")
      .replace(/^[ \t]*\|(.*)\|[ \t]*$/gm, (_, cells: string) => cells.replace(/\|/g, " "))
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/<(https?:\/\/[^>\s]+)>/g, "$1")
      .replace(/`+([^`]*)`+/g, "$1")
      .replace(/\*\*(?=\S)([^*]*?\S)\*\*/g, "$1")
      .replace(/(^|\W)__(?=\S)([^_]*?\S)__(?!\w)/g, "$1$2")
      .replace(/~~(?=\S)([^~]*?\S)~~/g, "$1")
      .replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?![\w*])/g, "$1$2")
      .replace(/(^|\W)_(?=\S)([^_\n]*?\S)_(?!\w)/g, "$1$2")
      // What a cut-off snippet leaves unpaired: a mark against a word on one side only, so 2**10
      // and x ** 2 stay.
      .replace(/(?<![\w*~`])(\*\*|~~|`)(?=[^\s*~`])/g, "")
      .replace(/(?<=[^\s*~`])(\*\*|~~|`)(?![\w*~`])/g, "")
      .replace(/\s+/g, " ")
      .trim()
  );
}
