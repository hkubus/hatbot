// Raw HTML is never rendered (react-markdown's default), other sites open in a new tab, and only
// the app's own pictures load. Streaming a block at a time as it is here re-parses from the block's
// start on each delta, but only that block: showing the text as it arrives either way.
import { API_PREFIX } from "@hatbot/shared";
import { createContext, lazy, memo, useContext, useEffect, useRef, useState } from "react";
import type { Components } from "react-markdown";
import { Chart, ChartPending, FileChart } from "./chart";
import { parseChart, parseChartFile } from "./chartspec";
import { useCopy } from "./copy";
import { Icon } from "./icons";
import { Link } from "./link";
import { splitBlocks } from "./md-blocks";

function CodeBlock({ code, children }: { code: string; children: React.ReactNode }) {
  const [copied, copy] = useCopy();
  const shown = useRef<HTMLPreElement>(null);
  return (
    <div className="code-block">
      <pre ref={shown}>{children}</pre>
      <button
        type="button"
        className="msg-act code-copy"
        title="Copy"
        onClick={(e) => {
          e.stopPropagation();
          copy(code.replace(/\n$/, ""), shown.current);
        }}
      >
        <Icon name={copied ? "check" : "copy"} />
      </button>
    </div>
  );
}

/** Whether the reply is still streaming: a chart block that doesn't parse yet is unfinished, not broken. */
const Streaming = createContext(false);

export type Node = { type: string; value?: string; children?: Node[] };
export const textOf = (n: Node): string => n.value ?? (n.children ?? []).map(textOf).join("");

export function appPath(href: string, origin = location.origin): string | null {
  let url: URL;
  try {
    url = new URL(href, origin);
  } catch {
    return null;
  }
  if (url.origin !== origin || url.pathname.startsWith(`${API_PREFIX}/`)) return null;
  return url.pathname + url.search + url.hash;
}

/** Whether a picture is served by Hatbot: the page may load nothing else (web.ts). */
const ownPicture = (src: string, origin = location.origin) => {
  try {
    return new URL(src, origin).origin === origin;
  } catch {
    return false;
  }
};

export const MD_COMPONENTS: Components = {
  a: ({ node: _, href, ...props }) => {
    if (href?.startsWith("#")) return <a {...props} href={href} />;
    const to = href ? appPath(href) : null;
    return to ? (
      <Link {...props} to={to} />
    ) : (
      <a {...props} href={href} target="_blank" rel="noreferrer noopener" />
    );
  },
  // A picture from another site would only show broken: it's a link to it instead.
  img: ({ node: _, src, alt }) => {
    if (typeof src !== "string" || !src) return alt || null;
    if (ownPicture(src)) return <img src={src} alt={alt ?? ""} loading="lazy" />;
    return (
      <a href={src} target="_blank" rel="noreferrer noopener">
        {alt || src}
      </a>
    );
  },
  pre: function Pre({ node, children }) {
    const streaming = useContext(Streaming);
    const code = node?.children.find((c) => c.type === "element" && c.tagName === "code");
    const lang =
      code?.type === "element" && Array.isArray(code.properties.className)
        ? String(code.properties.className[0] ?? "").replace(/^language-/, "")
        : "";
    const text = code ? textOf(code as Node) : "";
    if (lang === "chart") {
      const spec = parseChart(text);
      if (spec) return <Chart spec={spec} />;
      const file = parseChartFile(text);
      if (file) return <FileChart file={file} />;
      if (streaming) return <ChartPending />;
    }
    return <CodeBlock code={text}>{children}</CodeBlock>;
  },
};

export const isMarkdownFile = (a: { name: string; mediaType: string }) =>
  a.mediaType === "text/markdown" || /\.md$/i.test(a.name);

type Parser = React.ComponentType<{ text: string; components: Components }>;
let parser: { P: Parser } | undefined;
export const markdownLoaded = import("./md-parse").then((m) => {
  parser = { P: m.default };
  return m.default;
});

const MarkdownBlock = memo(function MarkdownBlock({ text }: { text: string }) {
  // Wrapped in an object: React would call a bare ComponentType as an updater, handing it the value.
  // Once it has loaded, a new block draws parsed from the start instead of plain for a frame.
  const [Parser, setParser] = useState(parser);
  // Loading it again after a reload's missing chunk is the reload's job, not a loop here.
  useEffect(() => {
    if (Parser) return;
    void markdownLoaded.then(
      (P) => setParser({ P }),
      () => {},
    );
  }, [Parser]);
  return Parser ? (
    <Parser.P text={text} components={MD_COMPONENTS} />
  ) : (
    <div className="md-plain">{text}</div>
  );
});

/** A whole file, as the reader shows one, once its parser has come. */
export const MarkdownArticle = lazy(async () => {
  const Parser = await markdownLoaded;
  return {
    default: ({ text, components }: { text: string; components: Components }) => (
      <article className="md">
        <Parser text={text} components={components} />
      </article>
    ),
  };
});

export const AssistantBody = memo(function AssistantBody({
  text,
  streaming = false,
}: {
  text: string;
  streaming?: boolean;
}) {
  return (
    <div className="md">
      <Streaming.Provider value={streaming}>
        {/* While it streams, only the block still growing is parsed again. */}
        {streaming ? (
          splitBlocks(text).map((block, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a reply's blocks only grow at the end
            <MarkdownBlock key={i} text={block} />
          ))
        ) : (
          <MarkdownBlock text={text} />
        )}
      </Streaming.Provider>
    </div>
  );
});
