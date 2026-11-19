import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { installDom } from "./dom";

installDom();
const { loadKatex, MD_COMPONENTS } = await import("../src/markdown");
const { default: Parse } = await import("../src/md-parse");
const { mathMarkdown } = await import("../src/md-math");

test("maths in a reply is drawn by KaTeX, inline and on its own, and a price stays text", async () => {
  await loadKatex();
  const html = renderToStaticMarkup(
    <Parse
      text={"It costs $5 to $10. With $a \\ne 0$:\n\n$$x = \\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}$$"}
      components={MD_COMPONENTS}
    />,
  );
  expect(html).toContain("It costs $5 to $10.");
  expect(html.match(/class="katex"/g)).toHaveLength(2);
  expect(html).toContain('class="katex-display"');
  expect(html).toContain('<annotation encoding="application/x-tex">a \\ne 0</annotation>');
});

test("maths KaTeX can't read shows as its source", async () => {
  await loadKatex();
  const html = renderToStaticMarkup(<Parse text={"$\\frac{a$"} components={MD_COMPONENTS} />);
  expect(html).toContain("<code>\\frac{a</code>");
});

test("single dollars are maths only by Pandoc's rule, so prices stay text", () => {
  for (const text of [
    "Between $5 and $10.",
    "$20,000 and $30,000",
    "From $5/$10 a month",
    "Set $HOME and $PATH.",
    "$ x$ and $x $",
    "A run costs **$1 to $3**, and `$HOME` stays code.",
  ])
    expect(mathMarkdown(text)).toBe(text);
  expect(mathMarkdown("Let $x_1$ and $y$ be $\\$5$.")).toBe("Let $$x_1$$ and $$y$$ be $$\\$5$$.");
});

test("\\( \\) is maths in the line, and \\[ \\] and a line of $$…$$ are maths on their own", () => {
  expect(mathMarkdown("So \\(a^2\\) grows.")).toBe("So $$a^2$$ grows.");
  expect(mathMarkdown("\\[a^2 + b^2\\]")).toBe("$$\na^2 + b^2\n$$");
  expect(mathMarkdown("$$a^2$$")).toBe("$$\na^2\n$$");
  expect(mathMarkdown("\\[\n  a = 1\n\\]\nso")).toBe("$$\na = 1\n$$\nso");
  expect(mathMarkdown("$$a = 1\n+ 2$$")).toBe("$$\na = 1\n+ 2\n$$");
  // In a list item, the item's indentation holds it there.
  expect(mathMarkdown("1. Solve:\n   \\[x^2 = 4\\]")).toBe("1. Solve:\n   $$\n   x^2 = 4\n   $$");
  expect(mathMarkdown("$$a$$ and $$b$$")).toBe("$$a$$ and $$b$$");
});

test("code is left as it's written", () => {
  for (const text of ["`$x$` and `\\(y\\)`", "```sh\necho $HOME$\n\\[x\\]\n```"])
    expect(mathMarkdown(text)).toBe(text);
});

test("an opening $$ closed after a blank line, or not at all, isn't maths to the end", () => {
  expect(mathMarkdown("$$\na\n\nMore.")).toBe("\\$\\$\na\n\nMore.");
  // Still streaming: what's come so far.
  expect(mathMarkdown("Then:\n$$\nx = ")).toBe("Then:\n$$\nx =");
});
