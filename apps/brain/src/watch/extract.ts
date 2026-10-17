// Picks a watcher's value out of a page or a tool's output, without the model.
import type { WatchCondition, WatchSource } from "@hatbot/shared";
import type { PatternJob } from "./pattern";

/** A check that didn't find a value; the message is for the owner and the model. */
export class WatchError extends Error {}

/** Values are compared and stored at most this long. */
const MAX_VALUE_CHARS = 4000;
/** A pattern looks at most at this much text, for at most this long. */
const MAX_PATTERN_CHARS = 200_000;
const PATTERN_MS = 5000;
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

/**
 * The pattern's first group or its whole match, null for none. It runs on a worker that is stopped
 * after `ms`, since a pattern can backtrack for hours on the wrong text.
 */
function firstMatch(pattern: string, text: string, ms: number): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL("./pattern.ts", import.meta.url).href);
    const done = () => {
      clearTimeout(timer);
      w.terminate();
    };
    const timer = setTimeout(() => {
      done();
      reject(new WatchError(`The pattern "${pattern}" took too long. Make it simpler.`));
    }, ms);
    w.onmessage = (e: MessageEvent<string | null>) => {
      done();
      resolve(e.data);
    };
    w.onerror = (e) => {
      done();
      reject(new WatchError(`The pattern "${pattern}" failed: ${e.message}`));
    };
    w.postMessage({ pattern, text: text.slice(0, MAX_PATTERN_CHARS) } satisfies PatternJob);
  });
}

/** Picks the value out of what was fetched or returned. */
export async function pick(
  body: string,
  contentType: string,
  source: WatchSource,
  patternMs = PATTERN_MS,
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
    try {
      new RegExp(source.pattern, "i");
    } catch {
      throw new WatchError(`"${source.pattern}" isn't a regular expression.`);
    }
    const m = await firstMatch(source.pattern, text, patternMs);
    if (m === null) throw new WatchError(`The pattern "${source.pattern}" matched nothing.`);
    text = m;
  }
  // Each element a selector matched on a line of its own, so neighbouring prices aren't read as one.
  const lines = source.selector && !source.pattern ? text.split("\n") : [text];
  return lines.map(collapse).filter(Boolean).join("\n").slice(0, MAX_VALUE_CHARS);
}

/**
 * A number as written: digits grouped in threes by spaces ("1 299,99"), or by dots, commas or
 * apostrophes, with a decimal part or not. Spaces never group across lines.
 */
const NUMBER =
  /[-−]?\d{1,3}(?:[ \u00a0\u202f\u2009]\d{3})+(?:[.,]\d+)?(?!\d)|[-−]?\d+(?:[.,']\d+)*/g;
/** Currencies a price is written next to: "1 299 zł", "PLN 1299", "€99", "99 złotych". */
const MONEY =
  "zł(?:oty(?:ch)?|ote)?|zl|pln|€|eur|\\$|usd|£|gbp|chf|kč|czk|kr|sek|nok|dkk|huf|lei|ron|¥|jpy|₹|₴|uah";
const MONEY_AFTER = new RegExp(`^\\s?(?:${MONEY})(?![\\p{L}])`, "iu");
const MONEY_BEFORE = new RegExp(`(?<![\\p{L}])(?:${MONEY})\\s?$`, "iu");

/** The number in one written form; `money` reads "1.299" as 1299, as a price would mean it. */
function parseNumber(written: string, money: boolean): number {
  let s = written.replace(/[ \u00a0\u202f\u2009']/g, "").replace("−", "-");
  const lastDot = s.lastIndexOf(".");
  const lastComma = s.lastIndexOf(",");
  // "1,299" and "1,299,000" group thousands, as does "1.299.000"; "12,5" and "0,299" don't.
  const grouped = (sep: string) => {
    const [head = "", ...rest] = s.split(sep);
    return /^-?[1-9]\d{0,2}$/.test(head) && rest.every((g) => g.length === 3);
  };
  if (lastDot >= 0 && lastComma >= 0) {
    // The later one is the decimal point.
    const decimal = lastDot > lastComma ? "." : ",";
    const group = decimal === "." ? "," : ".";
    s = s.split(group).join("").replace(decimal, ".");
  } else if (lastComma >= 0) {
    s = grouped(",") ? s.split(",").join("") : s.replace(",", ".");
  } else if (lastDot >= 0) {
    // A single dot is a decimal point, except in a price: "1.299 zł" is 1299.
    if (grouped(".") && (money || s.split(".").length > 2)) s = s.split(".").join("");
  }
  return Number(s);
}

/**
 * The price or number in a value: the first one next to a currency if there is one, else the first
 * that isn't a percentage ("-20%"), else the first percentage ("15%"). A negative one next to a
 * currency is a discount, not the price. "1 299,99 zł" is 1299.99, "1.299 zł" is 1299, "€1.299,00" is
 * 1299, "$1,299.00" is 1299, "-3.5 °C" is -3.5. NaN when there's none.
 */
export function numberIn(value: string): number {
  let first: number | null = null;
  let percent: number | null = null;
  for (const m of value.matchAll(NUMBER)) {
    let written = m[0];
    const start = m.index;
    const end = start + written.length;
    // A dash after a word or number is a range or a hyphen, not a minus: "100-200", "A-4".
    if (/^[-−]/.test(written) && /[\p{L}\p{N}]$/u.test(value.slice(0, start)))
      written = written.slice(1);
    const before = value.slice(Math.max(0, start - 4), start);
    const money = MONEY_AFTER.test(value.slice(end, end + 12)) || MONEY_BEFORE.test(before);
    const n = parseNumber(written, money);
    if (Number.isNaN(n)) continue;
    if (/^\s?%/.test(value.slice(end))) percent ??= n;
    // A price is never negative: "-300 zł" is a discount badge.
    else if (money && n >= 0) return n;
    else first ??= n;
  }
  return first ?? percent ?? Number.NaN;
}

/** Whether a value is in the condition: contains the text, or is below or above the number. */
function holds(c: WatchCondition, value: string): boolean {
  switch (c.when) {
    case "changed":
      return true;
    case "contains":
      return collapse(value).toLowerCase().includes(c.text.toLowerCase());
    case "missing":
      return !collapse(value).toLowerCase().includes(c.text.toLowerCase());
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
  // Only spacing: not a change (values saved before elements went on lines of their own, too).
  if (c.when === "changed") return previous !== null && collapse(previous) !== collapse(value);
  return holds(c, value) && !(previous !== null && holds(c, previous));
}
