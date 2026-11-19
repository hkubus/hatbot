import Markdown, { type Options } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import type { MD_COMPONENTS } from "./markdown";
import { mathMarkdown } from "./md-math";

// mathMarkdown writes maths in double dollars, so a price's lone $ stays text.
export const REMARK: Options["remarkPlugins"] = [
  remarkGfm,
  [remarkMath, { singleDollarTextMath: false }],
];

/** The parser alone, in its own chunk: markdown.tsx loads it beside the thread (markdownLoaded). */
export default function Parse({
  text,
  components = undefined,
}: {
  text: string;
  components?: typeof MD_COMPONENTS;
}) {
  return (
    <Markdown remarkPlugins={REMARK} components={components}>
      {mathMarkdown(text)}
    </Markdown>
  );
}
