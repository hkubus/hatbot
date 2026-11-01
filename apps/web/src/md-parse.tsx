import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { MD_COMPONENTS } from "./markdown";

export const REMARK = [remarkGfm];

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
      {text}
    </Markdown>
  );
}
