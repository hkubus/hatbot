// LaTeX as models write it, rewritten into remark-math's own syntax with single dollars off: $$…$$ in
// a line, and $$ on lines of their own around display maths. iOS reads the same rules
// (apps/ios/Hatbot/Core/Markdown.swift), so change them together.
import { FENCE } from "./md-blocks";

const DISPLAY = /^(\s*)(\$\$|\\\[)(.*)$/;
const space = (c: string | undefined) => c === undefined || /\s/.test(c);
const digit = (c: string | undefined) => c !== undefined && c >= "0" && c <= "9";

export function mathMarkdown(text: string): string {
  if (!/\$|\\[([]/.test(text)) return text;
  const lines = text.split("\n");
  const out: string[] = [];
  let fence = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const f = FENCE.exec(line)?.[1];
    if (fence) {
      if (f && f[0] === fence[0] && f.length >= fence.length && !line.trim().slice(f.length).trim())
        fence = "";
      out.push(line);
      continue;
    }
    if (f) {
      fence = f;
      out.push(line);
      continue;
    }
    const d = display(lines, i);
    if (d) {
      out.push(`${d.indent}$$`, ...d.body.map((l) => d.indent + l.trim()));
      if (d.closed) out.push(`${d.indent}$$`);
      i = d.end;
      continue;
    }
    out.push(inlineMath(line));
  }
  return out.join("\n");
}

/**
 * Display maths from line `i`: $$ or \[ starting the line and its closing ending it, there or on a
 * later line with no blank one between. Unclosed at the end, it's a reply still streaming.
 */
function display(lines: string[], i: number) {
  const m = DISPLAY.exec(lines[i] as string);
  if (!m) return null;
  const [, indent = "", open, rest = ""] = m;
  const close = open === "$$" ? "$$" : "\\]";
  const body: string[] = [];
  let text = rest.trimEnd();
  for (let j = i; j < lines.length; j++) {
    if (j > i) {
      text = (lines[j] as string).trimEnd();
      if (!text.trim()) return null;
    }
    const at = text.indexOf(close);
    if (at === -1) {
      if (text.trim()) body.push(text);
      continue;
    }
    // A closing before the line's end is maths in the line: "$$a$$ and $$b$$".
    if (at !== text.length - close.length) return null;
    if (text.slice(0, at).trim()) body.push(text.slice(0, at));
    return body.length ? { indent, body, end: j, closed: true } : null;
  }
  return body.length ? { indent, body, end: lines.length - 1, closed: false } : null;
}

/** \(…\), \[…\] and $…$ in a line, outside code; a lone $ (prices) stays as it is. */
export function inlineMath(line: string): string {
  let out = "";
  let i = 0;
  while (i < line.length) {
    const c = line[i] as string;
    if (c === "`") {
      const run = /^`+/.exec(line.slice(i))?.[0] ?? "`";
      const end = line.indexOf(run, i + run.length);
      const stop = end === -1 ? i + run.length : end + run.length;
      out += line.slice(i, stop);
      i = stop;
      continue;
    }
    if (c === "\\") {
      const next = line[i + 1];
      const close = next === "(" ? "\\)" : next === "[" ? "\\]" : null;
      const end = close ? line.indexOf(close, i + 2) : -1;
      const tex = line.slice(i + 2, end);
      if (close && end !== -1 && tex.trim() && !tex.includes("$$")) {
        out += `$$${tex}$$`;
        i = end + 2;
      } else {
        out += line.slice(i, i + 2);
        i += 2;
      }
      continue;
    }
    if (c === "$") {
      const run = /^\$+/.exec(line.slice(i))?.[0] as string;
      if (run.length > 1) {
        // remark-math's own, copied to its closing. Unclosed, it would open maths running to the end.
        const end = line.indexOf(run, i + run.length);
        out += end === -1 ? "\\$".repeat(run.length) : line.slice(i, end + run.length);
        i = end === -1 ? i + run.length : end + run.length;
        continue;
      }
      const end = closingDollar(line, i);
      if (end === -1) {
        out += c;
        i++;
      } else {
        out += `$$${line.slice(i + 1, end)}$$`;
        i = end + 1;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * Pandoc's rule, so "$5 and $10" stays text: no space just inside either dollar, no dollar after a
 * space in between, and no digit right after the closing one. Nor a backtick in between: "costs $3,
 * see `$HOME`" is a price and code.
 */
function closingDollar(line: string, open: number): number {
  if (space(line[open + 1])) return -1;
  for (let j = open + 1; j < line.length; j++) {
    const c = line[j];
    if (c === "\\") {
      j++;
      continue;
    }
    if (c === "`") return -1;
    if (c !== "$") continue;
    if (space(line[j - 1]) || digit(line[j + 1]) || line[j + 1] === "$") return -1;
    return j;
  }
  return -1;
}
