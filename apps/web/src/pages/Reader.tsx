import { type ReactNode, useEffect, useState } from "react";
import Markdown, { type Components } from "react-markdown";
import { ApiError, api, attachmentUrl } from "../api";
import { Icon } from "../icons";
import { LoadError } from "../load";
import { MD_COMPONENTS, type Node, REMARK, textOf } from "../markdown";
import { navigate } from "../router";
import { useStore } from "../store";

type Read = { text: string; name: string; from: "memory" | "file" };
type Shown =
  | { state: "loading" }
  | { state: "gone" }
  | { state: "failed" }
  | (Read & { state: "ready" });

const enc = encodeURIComponent;
const baseName = (path: string) => path.split("/").pop() || path;

/** A heading's id as GitHub makes it, so a link to `#a-heading` reaches it. */
const slug = (text: string) =>
  text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s+/g, "-");

function heading(Tag: "h1" | "h2" | "h3" | "h4") {
  return function Heading({ node, children }: { node?: unknown; children?: ReactNode }) {
    const id = node ? slug(textOf(node as Node)) : "";
    return <Tag id={id || undefined}>{children}</Tag>;
  };
}

const COMPONENTS: Components = {
  ...MD_COMPONENTS,
  h1: heading("h1"),
  h2: heading("h2"),
  h3: heading("h3"),
  h4: heading("h4"),
};

// An older brain answers a missing memory file with a 400.
const isGone = (err: unknown) =>
  err instanceof ApiError &&
  (err.status === 404 || (err.status === 400 && err.message.startsWith("not found")));

function fileName(res: Response): string {
  const cd = res.headers.get("content-disposition") ?? "";
  const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(cd)?.[1];
  if (utf8)
    try {
      return decodeURIComponent(utf8);
    } catch {}
  return /filename="([^"]*)"/i.exec(cd)?.[1] || "File";
}

async function readMemory(path: string): Promise<Read> {
  const r = await api<{ content: string }>(`/memory/file?path=${enc(path)}`);
  return { text: r.content, name: baseName(path), from: "memory" };
}

// Fetched rather than opened: the brain serves Markdown as a download, never as a page.
async function readFile(id: number): Promise<Read> {
  const res = await fetch(attachmentUrl(id), { credentials: "same-origin" });
  if (res.status === 401) window.dispatchEvent(new Event("hatbot:unauthorized"));
  if (!res.ok) throw new ApiError(res.status, `HTTP ${res.status}`);
  return { text: await res.text(), name: fileName(res), from: "file" };
}

function saveAs(text: string, name: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/markdown" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * A Markdown file to read: a note (`path`), else an attachment (`file`). With both, the attachment
 * stands in when the note is gone, as a research report is kept both ways.
 */
export function Reader({ path, file }: { path: string; file: number }) {
  const [shown, setShown] = useState<Shown>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);
  // A note is read again when memory changes, e.g. after you edit it.
  const version = useStore((s) => (path ? s.memoryVersion : 0));

  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry and memory changes read it again
  useEffect(() => {
    let stale = false;
    const read = async () => {
      if (path)
        try {
          return await readMemory(path);
        } catch (err) {
          if (!file || !isGone(err)) throw err;
        }
      if (!file) throw new ApiError(404, "gone");
      return readFile(file);
    };
    read().then(
      (r) => {
        if (!stale) setShown({ state: "ready", ...r });
      },
      (err) => {
        if (!stale) setShown({ state: isGone(err) ? "gone" : "failed" });
      },
    );
    return () => {
      stale = true;
    };
  }, [path, file, attempt, version]);

  const back = () => {
    if (history.length > 1) history.back();
    else navigate(path ? `/memory?path=${enc(path)}` : "/");
  };
  const ready = shown.state === "ready" ? shown : null;
  const name = ready?.name ?? (path ? baseName(path) : "");

  return (
    <section className="view">
      <div className="page narrow reader">
        <div className="page-head reader-head">
          <button type="button" className="btn sm ghost back" onClick={back}>
            <Icon name="chevron" />
            Back
          </button>
          <span className="reader-name" title={ready?.from === "memory" ? path : undefined}>
            {name}
          </span>
          {ready?.from === "memory" && (
            <>
              <button
                type="button"
                className="btn sm"
                onClick={() => navigate(`/memory?path=${enc(path)}`)}
              >
                Edit
              </button>
              <button type="button" className="btn sm" onClick={() => saveAs(ready.text, name)}>
                Download
              </button>
            </>
          )}
          {ready?.from === "file" && (
            <a className="btn sm" href={attachmentUrl(file, true)}>
              Download
            </a>
          )}
        </div>
        {shown.state === "gone" ? (
          <div className="empty">This file is gone.</div>
        ) : shown.state === "failed" ? (
          <LoadError
            error="Couldn't open this file."
            retry={() => {
              setShown({ state: "loading" });
              setAttempt((n) => n + 1);
            }}
          />
        ) : ready ? (
          <article className="md">
            <Markdown remarkPlugins={REMARK} components={COMPONENTS}>
              {ready.text}
            </Markdown>
          </article>
        ) : null}
      </div>
    </section>
  );
}
