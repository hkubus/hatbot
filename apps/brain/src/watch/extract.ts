// Picks a watcher's value out of a page or a tool's output, without the model.
import type { WatchCondition, WatchSource } from "@hatbot/shared";

/** A check that didn't find a value; the message is for the owner and the model. */
export class WatchError extends Error {}

/** Values are compared and stored at most this long. */
const MAX_VALUE_CHARS = 4000;
const SKIPPED = "head, script, style, noscript, template, svg";

const collapse = (s: string) => s.replace(/\s+/g, " ").trim();
const looksHtml = (body: string, contentType: string) =>
  contentType.includes("html") || /^\s*<(!doctype|html|head|body|div)/i.test(body);

/** The text of each element `selector` matches, outermost matches only. */
async function selectText(html: string, selector: string): Promise<string[]> {
  const parts: string[][] = [];
  let depth = 0;
  let rewriter: HTMLRewriter;
  try {
    rewriter = new HTMLRewriter().on(selector, {
      element(el) {
        if (depth === 0) parts.push([]);
        // A void element (img, br) has no end tag and no text.
        if (!el.canHaveContent) return;
        depth++;
        el.onEndTag(() => {
          depth--;
        });
      },
      text(t) {
        if (depth > 0) parts.at(-1)?.push(t.text);
      },
    });
  } catch {
    throw new WatchError(`"${selector}" isn't a CSS selector this can use.`);
  }
  await rewriter.transform(new Response(html)).text();
  return parts.map((p) => collapse(p.join(""))).filter(Boolean);
}

/** The page's visible text, roughly: no head, scripts or styles. */
async function pageText(html: string): Promise<string> {
  const out: string[] = [];
  let skip = 0;
  await new HTMLRewriter()
    .on(SKIPPED, {
      element(el) {
        if (!el.canHaveContent) return;
        skip++;
        el.onEndTag(() => {
          skip--;
        });
      },
    })
    // Elements end words: "<p>a</p><p>b</p>" is "a b", not "ab".
    .on("*", {
      element() {
        out.push(" ");
      },
    })
    .onDocument({
      text(t) {
        if (!skip) out.push(t.text);
      },
    })
    .transform(new Response(html))
    .text();
  return collapse(decodeEntities(out.join("")));
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e: string) => {
    if (e[0] === "#")
      return String.fromCodePoint(
        e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1)),
      );
    return ENTITIES[e.toLowerCase()] ?? all;
  });
}

/** The value at a dotted path, e.g. "items.0.price". */
function atPath(data: unknown, path: string): unknown {
  let v: unknown = data;
  for (const key of path.split(".")) {
    if (v === null || typeof v !== "object") return undefined;
    v = (v as Record<string, unknown>)[key];
  }
  return v;
}

/** Picks the value out of what was fetched or returned. */
export async function pick(
  body: string,
  contentType: string,
  source: WatchSource,
): Promise<string> {
  let text: string;
  if (source.path) {
    let data: unknown;
    try {
      data = JSON.parse(body);
    } catch {
      throw new WatchError("It isn't JSON, so a path doesn't apply. Use a selector or a pattern.");
    }
    const v = atPath(data, source.path);
    if (v === undefined) throw new WatchError(`There's nothing at "${source.path}".`);
    text = typeof v === "string" ? v : JSON.stringify(v);
  } else if (source.selector) {
    if (!looksHtml(body, contentType))
      throw new WatchError("It isn't a web page, so a selector doesn't apply.");
    const parts = await selectText(body, source.selector);
    if (!parts.length) throw new WatchError(`"${source.selector}" matched nothing on the page.`);
    text = decodeEntities(parts.join("\n"));
  } else {
    text = looksHtml(body, contentType) ? await pageText(body) : body;
  }
  if (source.pattern) {
    let re: RegExp;
    try {
      re = new RegExp(source.pattern, "i");
    } catch {
      throw new WatchError(`"${source.pattern}" isn't a regular expression.`);
    }
    const m = re.exec(text);
    if (!m) throw new WatchError(`The pattern "${source.pattern}" matched nothing.`);
    text = m[1] ?? m[0];
  }
  return collapse(text).slice(0, MAX_VALUE_CHARS);
}

/**
 * The first number in a value: "€1.299,00" is 1299, "1,299.00" is 1299, "-3.5 °C" is -3.5.
 * NaN when there's none.
 */
export function numberIn(value: string): number {
  const m = /-?\d[\d.,\s  ']*/.exec(value);
  if (!m) return Number.NaN;
  let s = m[0].replace(/[\s  ']/g, "").replace(/[.,]$/, "");
  const lastDot = s.lastIndexOf(".");
  const lastComma = s.lastIndexOf(",");
  if (lastDot >= 0 && lastComma >= 0) {
    // The later one is the decimal point.
    const decimal = lastDot > lastComma ? "." : ",";
    const group = decimal === "." ? "," : ".";
    s = s.split(group).join("").replace(decimal, ".");
  } else if (lastComma >= 0) {
    // "1,299" and "1,299,000" group thousands; "12,5" has a decimal comma.
    const groups = s.split(",");
    s = groups.slice(1).every((g) => g.length === 3) ? groups.join("") : s.replace(",", ".");
  } else if (s.split(".").length > 2) {
    // "1.299.000"; a single dot is a decimal point.
    s = s.split(".").join("");
  }
  return Number(s);
}

/** Whether a value is in the condition: contains the text, or is below or above the number. */
function holds(c: WatchCondition, value: string): boolean {
  switch (c.when) {
    case "changed":
      return true;
    case "contains":
      return value.toLowerCase().includes(c.text.toLowerCase());
    case "missing":
      return !value.toLowerCase().includes(c.text.toLowerCase());
    case "below":
      return numberIn(value) < c.value;
    case "above":
      return numberIn(value) > c.value;
  }
}

/**
 * Whether a new value counts: for "changed", any change after the first check; otherwise a move into
 * the condition (the first check counts if it's already there), not every check while it holds.
 */
export function counts(c: WatchCondition, previous: string | null, value: string): boolean {
  if (c.when === "changed") return previous !== null && previous !== value;
  return holds(c, value) && !(previous !== null && holds(c, previous));
}
