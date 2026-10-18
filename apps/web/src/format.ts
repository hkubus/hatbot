// Money, model names, times and Markdown made plain, the same on every page.

/** Dollars to the cent; a cost under half a cent shows as "<$0.01", not "$0.00". */
export const usd = (v: number) => (v > 0 && v < 0.005 ? "<$0.01" : `$${v.toFixed(2)}`);

/** "08:05". */
export const time = (iso: string) =>
  new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

/** "11 Oct". */
export const day = (date: string | Date) =>
  new Date(date).toLocaleDateString("en-GB", { day: "numeric", month: "short" });

const today = (iso: string) => new Date(iso).toDateString() === new Date().toDateString();

/** "08:05" today, else "11 Oct". */
export const timeOrDay = (iso: string) => (today(iso) ? time(iso) : day(iso));

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

/**
 * "Opus 5.5" for claude-opus-5-5, "Opus 4.8" for a fallback's claude-opus-4-8, worked out from the
 * id so a new model has a name too; an id of another shape stays as it is.
 */
export function modelName(id: string): string {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(id);
  if (!m) return id;
  const [, family = "", major, minor] = m;
  return `${family.charAt(0).toUpperCase()}${family.slice(1)} ${major}${minor ? `.${minor}` : ""}`;
}

/**
 * Markdown as one line of plain text, for snippets, finds and notes: links and images keep their
 * words, and marks like **, # and - go. Search's match marks pass through.
 */
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
