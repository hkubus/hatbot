// Money, model names and Markdown made plain, the same on every page.

/** Dollars to the cent; a cost under half a cent shows as "<$0.01", not "$0.00". */
export const usd = (v: number) => (v > 0 && v < 0.005 ? "<$0.01" : `$${v.toFixed(2)}`);

const MODEL_NAMES: Record<string, string> = {
  "claude-opus-5-5": "Opus 5.5",
  // What a declined Opus 5.5 request may be answered by, priced and recorded under its own id.
  "claude-opus-5": "Opus 5",
  "claude-opus-4-8": "Opus 4.8",
  "claude-sonnet-5-5": "Sonnet 5.5",
  "claude-sonnet-5": "Sonnet 5",
  "claude-haiku-5-5": "Haiku 5.5",
  "claude-haiku-4-5": "Haiku 4.5",
};

/** "Opus 5.5" for claude-opus-5-5; an id it doesn't know stays as it is. */
export const modelName = (id: string) => MODEL_NAMES[id] ?? id;

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
      // What a cut-off snippet leaves unpaired.
      .replace(/\*\*|~~|`/g, "")
      .replace(/\s+/g, " ")
      .trim()
  );
}
