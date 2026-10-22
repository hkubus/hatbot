// The file open in Memory's editor. Its text belongs to its path: opening another file starts a new
// one, so an unsaved draft can't end up shown, or saved, under another file's name.

export type Doc = {
  path: string;
  content: string;
  /** The file as saved; "" for one that isn't there yet. */
  saved: string;
  /** The version your edit started from; "" for a new file. */
  baseSha: string;
  /** "new": not there yet. "failed": couldn't be read, so it can't be saved over either. */
  state: "loading" | "ready" | "new" | "failed";
  error?: string;
};

export const loading = (path: string): Doc => ({
  path,
  content: "",
  saved: "",
  baseSha: "",
  state: "loading",
});

export function newDoc(path: string): Doc {
  const title = path.split("/").pop()?.replace(/\.md$/, "").replace(/-/g, " ") ?? "";
  const content = `# ${title.charAt(0).toUpperCase()}${title.slice(1)}\n`;
  return { path, content, saved: "", baseSha: "", state: "new" };
}

/** Unsaved edits: only in a file that's loaded, or new. */
export const isDirty = (d: Doc | null) =>
  !!d && (d.state === "ready" || d.state === "new") && d.content !== d.saved;

/**
 * The doc once `path` has been read. A doc for another path is left alone. Your edits stay; if the
 * file is still what they started from (your own save came back), their version catches up.
 */
export function readDoc(
  d: Doc | null,
  path: string,
  file: { content: string; sha: string },
): Doc | null {
  if (!d || d.path !== path) return d;
  if (!isDirty(d))
    return { path, content: file.content, saved: file.content, baseSha: file.sha, state: "ready" };
  return file.content === d.saved ? { ...d, baseSha: file.sha, state: "ready" } : d;
}

/** The doc once reading `path` failed: a file that isn't there is a new, empty one. */
export function readFailed(
  d: Doc | null,
  path: string,
  notFound: boolean,
  error: string,
): Doc | null {
  if (!d || d.path !== path || isDirty(d)) return d;
  if (notFound) return { path, content: "", saved: "", baseSha: "", state: "new" };
  // A refresh that failed keeps what's shown; a first load says why.
  return d.state === "loading" || d.state === "failed" ? { ...d, state: "failed", error } : d;
}
