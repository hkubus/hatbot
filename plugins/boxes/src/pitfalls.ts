// Simple mistakes in a box's page that fail without saying much, found by reading it: the brain never
// runs or builds a box's code.

import { BOX_CONFIG, BOX_SERVER, type BoxFile } from "@hatbot/shared/hatbox";

// Every repeat is bounded or scanned once: a page is up to 1 MB, and an unbounded lazy match restarted
// at each of thousands of unclosed tags takes minutes, with the brain waiting.
const SCRIPT_OPEN = /<script\b([^>]{0,500})>/gi;
const SCRIPT_CLOSE = /<\/script>/gi;
const IMPORTS = /(^|[;}\n])\s*import\s*[\w{*'"]|\bimport\s*\(/;
const TYPESCRIPT = [
  /\binterface\s+[A-Z]\w*\s*(<[^>]{0,200}>)?\s*\{/,
  /\btype\s+[A-Z]\w*\s*(<[^>]{0,200}>)?\s*=[^=]/,
  /\b(let|const|var)\s+[\w$]+\s*:\s*[\w$[{(<]/,
  /\bfunction\b[^(]{0,200}\([^)]{0,500}\)\s*:\s*[\w$<[{]/,
  /\(\s*[\w$]+\??\s*:\s*(string|number|boolean|any|unknown|\w*Event|HTML\w*Element)\b[^()]*\)\s*(=>|\{)/,
  /\bas\s+(const|HTML\w*Element)\b/,
];
const FROM_WEB =
  /<(script|link|img|source|video|audio|iframe|embed|object|track|image|use)\b[^>]{0,1000}?\s(src|href|srcset|data|poster|xlink:href)\s*=\s*["']?\s*(https?:)?\/\/|url\(\s*["']?\s*(https?:)?\/\/|@import\s+(url\()?\s*["']?(https?:)?\/\//i;
const FETCHES_WEB = /\b(fetch|EventSource|WebSocket)\s*\(\s*["'`](https?|wss?):/;
const STORAGE = /\b(localStorage|sessionStorage|indexedDB)\b|\bdocument\.cookie\b/;
const DIALOG =
  /(?<![\w$.]|function\s+)(alert|confirm|prompt)\s*\((?![^)]{0,500}\)\s*\{)|\bwindow\.(alert|confirm|prompt)\s*\(/;

/** Roughly, enough that a comment naming localStorage isn't taken for a use. */
function uncommented(code: string) {
  let out = "";
  let at = 0;
  for (;;) {
    const open = code.indexOf("/*", at);
    const close = open < 0 ? -1 : code.indexOf("*/", open + 2);
    if (close < 0) {
      out += code.slice(at);
      break;
    }
    out += code.slice(at, open);
    at = close + 2;
  }
  return out.replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

/** Each inline <script>'s attributes and code, as `<script ...>code</script>` would match them. */
function inlineScripts(html: string): Array<[attrs: string, code: string]> {
  const open = new RegExp(SCRIPT_OPEN);
  const close = new RegExp(SCRIPT_CLOSE);
  const found: Array<[string, string]> = [];
  for (let m = open.exec(html); m; m = open.exec(html)) {
    close.lastIndex = open.lastIndex;
    const end = close.exec(html);
    // No </script> after this one, so none after any later one either.
    if (!end) break;
    found.push([m[1] ?? "", html.slice(open.lastIndex, end.index)]);
    open.lastIndex = close.lastIndex;
  }
  return found;
}

/** A box with files is built by Bun, which leaves inline scripts as they are. Its backend isn't checked. */
export function pitfalls(files: BoxFile[], built: boolean): string[] {
  const found = new Set<string>();
  for (const f of files) {
    if (f.path === BOX_SERVER || f.path === BOX_CONFIG) continue;
    const name = built ? f.path : "The page";
    const html = f.path.endsWith(".html");
    const scripts = html
      ? inlineScripts(f.content)
          .filter(([attrs]) => {
            const type = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs)?.[1];
            const js = !type || /^(module|(text|application)\/javascript)$/i.test(type);
            return js && !/\bsrc\s*=/i.test(attrs);
          })
          .map(([, code]) => uncommented(code))
      : /\.(m?[jt]sx?)$/.test(f.path)
        ? [uncommented(f.content)]
        : [];
    const inline = built ? `${f.path}: an inline <script>` : "The page's <script>";
    for (const code of html ? scripts : []) {
      if (IMPORTS.test(code))
        found.add(
          built
            ? `${inline} uses import, which the build leaves as it is, so it fails; load the code by path instead (<script type="module" src="./app.ts">).`
            : `${inline} uses import, which fails: a box of one page has nothing to import.`,
        );
      if (TYPESCRIPT.some((t) => t.test(code)))
        found.add(`${inline} has TypeScript in it, which runs as it is and fails.`);
      if (FETCHES_WEB.test(code))
        found.add(
          `${name} fetches from the web, which the page can't; a backend can, reached with hatbox.fetch.`,
        );
    }
    if ((html || f.path.endsWith(".css")) && FROM_WEB.test(f.content))
      found.add(
        `${name} loads something from the web (a script, style, picture or font), which the box's CSP refuses; inline it.`,
      );
    for (const code of scripts) {
      const storage = STORAGE.exec(code)?.[0];
      if (storage)
        found.add(
          `${name} uses ${storage}, which the box's sandbox blocks; keep data with hatbox.store.`,
        );
      const dialog = DIALOG.exec(code);
      if (dialog)
        found.add(
          `${name} calls ${dialog[1] ?? dialog[2]}(), which does nothing in the box's sandbox; show it in the page.`,
        );
    }
  }
  return [...found];
}
