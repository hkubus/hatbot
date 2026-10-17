import { expect, test } from "bun:test";
import { Glob } from "bun";

// A screen reader announces a field by its name. A placeholder isn't one, and a select without one
// reads as just its current option.
test("every field has a name", async () => {
  const src = new URL("../src/", import.meta.url).pathname;
  const unnamed: string[] = [];
  for await (const file of new Glob("**/*.tsx").scan(src)) {
    const text = await Bun.file(src + file).text();
    for (const m of text.matchAll(/<(input|select|textarea)\b/g)) {
      // The whole tag, past any > inside its {expressions}.
      let depth = 0;
      let end = m.index;
      for (; end < text.length; end++) {
        const c = text[end];
        if (c === "{") depth++;
        else if (c === "}") depth--;
        else if (c === ">" && depth === 0) break;
      }
      const tag = text.slice(m.index, end);
      if (/aria-label(ledby)?=|type="(hidden|file)"/.test(tag)) continue;
      // Inside a <label>.
      const before = text.slice(0, m.index);
      if (before.lastIndexOf("<label") > before.lastIndexOf("</label>")) continue;
      unnamed.push(`${file}:${before.split("\n").length} <${m[1]}>`);
    }
  }
  expect(unnamed).toEqual([]);
});
