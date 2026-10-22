import type { Commit, MemoryFile, Proposal, SkillStatus } from "@hatbot/shared";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAction } from "../action";
import { ApiError, api, errorText } from "../api";
import { ask, askText, useLeaveGuard } from "../confirm";
import { lineDiff } from "../diff";
import { dayTime } from "../format";
import { Icon } from "../icons";
import { LoadError } from "../load";
import { type Doc, isDirty, loading, newDoc, readDoc, readFailed } from "../memory-doc";
import { navigate } from "../router";
import { bumpMemory, loadProposals, putProposal, startTeach, useStore } from "../store";
import type { Toast } from "../toast";

type Selection =
  | { kind: "file"; path: string }
  | { kind: "diff"; commit: Commit }
  | { kind: "proposal"; id: number };
type History = { path: string; log: Commit[]; older: boolean; error: string };

const enc = encodeURIComponent;
const PAGE = 50;

function DiffView({ diff }: { diff: string }) {
  const lines = diff
    .split("\n")
    .filter((l) => !/^(diff --git|index |--- |\+\+\+ |new file|deleted file)/.test(l));
  return (
    <div className="diff">
      {lines.map((l, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: diff lines have no identity of their own
          key={i}
          className={
            l.startsWith("+")
              ? "add"
              : l.startsWith("-")
                ? "del"
                : l.startsWith("@@")
                  ? "muted"
                  : ""
          }
        >
          {l || " "}
        </div>
      ))}
    </div>
  );
}

function ProposalView({ p }: { p: Proposal }) {
  return (
    <div style={{ padding: "16px 20px" }}>
      {p.reason && <p className="proposal-reason">{p.reason}</p>}
      {p.changes.map((c) => (
        <div key={c.path} className="proposal-file">
          <div className="path">
            {c.path}
            {c.before === null ? " (new)" : c.after === null ? " (deleted)" : ""}
          </div>
          <div className="diff">
            {lineDiff(c.before, c.after).map((l, i) => (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: diff lines have no identity of their own
                key={i}
                className={l.kind === "same" ? "" : l.kind === "gap" ? "muted" : l.kind}
              >
                {l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "}
                {l.text || " "}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export function Memory({ toast, open }: { toast: Toast; open?: string }) {
  const version = useStore((s) => s.memoryVersion);
  const allProposals = useStore((s) => s.proposals);
  const pending = useMemo(
    () =>
      Object.values(allProposals)
        .filter((p) => p.status === "pending")
        .sort((a, b) => b.id - a.id),
    [allProposals],
  );
  const [skills, setSkills] = useState<SkillStatus[]>([]);
  const { busy, run } = useAction();
  const teach = useStore((s) => s.teach);
  const drafts = useMemo(
    () =>
      Object.values(teach)
        .filter((t) => t.status === "drafting" || t.status === "draft" || t.status === "failed")
        .sort((a, b) => b.id - a.id),
    [teach],
  );
  const [files, setFiles] = useState<MemoryFile[]>([]);
  const [sel, setSel] = useState<Selection>({ kind: "file", path: open || "INDEX.md" });
  const [doc, setDoc] = useState<Doc | null>(null);
  /** Someone else saved the file while you were editing it. */
  const [conflict, setConflict] = useState<{ sha: string; content: string } | null>(null);
  const [diff, setDiff] = useState("");
  /** History is the last file you opened's. */
  const [histPath, setHistPath] = useState(open || "INDEX.md");
  const [hist, setHist] = useState<History | null>(null);
  const [histAttempt, setHistAttempt] = useState(0);
  // Another file's commits never show, while this one's load or if they don't.
  const shownHist = hist?.path === histPath ? hist : null;

  const dirty = isDirty(doc);

  // Leaving with unsaved changes asks first: the sidebar, Back, closing the tab.
  useLeaveGuard(dirty);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reload when memory changes anywhere
  useEffect(() => {
    api<MemoryFile[]>("/memory/tree").then(setFiles, () => {});
    api<SkillStatus[]>("/skills").then(setSkills, () => setSkills([]));
  }, [version]);
  useEffect(() => {
    void loadProposals().catch(() => {});
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: again when memory changes anywhere
  useEffect(() => {
    let stale = false;
    const path = histPath;
    api<Commit[]>(`/memory/log?path=${enc(path)}&limit=${PAGE}`).then(
      (log) => {
        if (!stale) setHist({ path, log, older: log.length === PAGE, error: "" });
      },
      (err) => {
        if (stale) return;
        const error = errorText(err);
        setHist((h) =>
          h?.path === path ? { ...h, error } : { path, log: [], older: false, error },
        );
      },
    );
    return () => {
      stale = true;
    };
  }, [histPath, version, histAttempt]);
  const loadOlder = () => {
    const path = histPath;
    api<Commit[]>(
      `/memory/log?path=${enc(path)}&limit=${PAGE}&skip=${shownHist?.log.length ?? 0}`,
    ).then(
      (l) =>
        // Dropped if you've opened another file since.
        setHist((h) =>
          h?.path !== path
            ? h
            : {
                ...h,
                log: [...h.log, ...l.filter((c) => !h.log.some((x) => x.sha === c.sha))],
                older: l.length === PAGE,
              },
        ),
      (err) => toast(errorText(err), "error"),
    );
  };

  /** Reads a file into the editor; `quiet` refreshes the one shown without blanking it. */
  const read = useCallback((path: string, quiet = false) => {
    if (!quiet) setDoc(loading(path));
    api<{ content: string; sha: string }>(`/memory/file?path=${enc(path)}`).then(
      (r) => setDoc((d) => readDoc(d, path, { content: r.content, sha: r.sha ?? "" })),
      (err) =>
        setDoc((d) =>
          readFailed(
            d,
            path,
            // An older brain answers a missing file with a 400.
            err instanceof ApiError &&
              (err.status === 404 || (err.status === 400 && err.message.startsWith("not found"))),
            errorText(err),
          ),
        ),
    );
  }, []);
  useEffect(() => {
    if (sel.kind === "file" && doc?.path !== sel.path) read(sel.path);
  }, [sel, doc?.path, read]);
  // Memory changed somewhere: the file again, keeping your edits.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only when memory changes
  useEffect(() => {
    if (doc && doc.state !== "loading") read(doc.path, true);
  }, [version]);

  /** Everything that changes what's shown goes through here: a draft isn't dropped unasked. */
  const select = async (next: Selection) => {
    if (dirty && !(await ask({ text: "Discard your unsaved changes?", ok: "Discard" }))) return;
    setConflict(null);
    if (dirty) setDoc(null);
    if (next.kind === "file") setHistPath(next.path);
    if (next.kind === "diff") setDiff("");
    setSel(next);
  };

  useEffect(() => {
    if (sel.kind !== "diff") return;
    // Only the commit still shown: an earlier one's diff may answer last.
    let stale = false;
    api<{ diff: string }>(`/memory/diff/${sel.commit.sha}`).then(
      (r) => {
        if (!stale) setDiff(r.diff);
      },
      (err) => {
        if (!stale) toast(errorText(err), "error");
      },
    );
    return () => {
      stale = true;
    };
  }, [sel, toast]);

  const groups = useMemo(() => {
    const g = new Map<string, MemoryFile[]>();
    for (const f of files) {
      const dir = f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : "";
      g.set(dir, [...(g.get(dir) ?? []), f]);
    }
    return [...g].sort(([a], [b]) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)));
  }, [files]);

  /** `over`: the version to replace, after you've chosen to overwrite one saved meanwhile. */
  const save = async (over?: string) => {
    // Only what's in the editor, into the file it was opened from.
    if (!doc || (doc.state !== "ready" && doc.state !== "new")) return;
    const { path, content } = doc;
    try {
      const r = await api<{ sha: string | null }>(`/memory/file?path=${enc(path)}`, {
        method: "PUT",
        body: { content, message: `Edit ${path}`, baseSha: over ?? doc.baseSha },
      });
      setConflict(null);
      // Its new version comes with the refresh that follows.
      setDoc((d) => (d?.path === path ? { ...d, saved: content, state: "ready" } : d));
      toast(r.sha ? `Saved (${r.sha.slice(0, 7)})` : "No changes", r.sha ? "done" : "info");
      bumpMemory();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        const now = err.data as { sha: string; content: string };
        return setConflict({ sha: now.sha, content: now.content });
      }
      toast(errorText(err, "Couldn't save"), "error");
    }
  };
  // Your edit goes; the file as it's now saved comes in.
  const takeTheirs = () => {
    if (!conflict) return;
    setDoc(
      (d) =>
        d && {
          ...d,
          content: conflict.content,
          saved: conflict.content,
          baseSha: conflict.sha,
          state: "ready",
        },
    );
    setConflict(null);
  };

  const newFile = async () => {
    const path = await askText({
      text: "New file's path",
      placeholder: "projects/garden.md",
      ok: "Create",
    });
    if (!path) return;
    const p = path.endsWith(".md") ? path : `${path}.md`;
    // One that's there already opens, rather than being started again.
    if (files.some((f) => f.path === p)) return select({ kind: "file", path: p });
    if (dirty && !(await ask({ text: "Discard your unsaved changes?", ok: "Discard" }))) return;
    setConflict(null);
    setDoc(newDoc(p));
    setHistPath(p);
    setSel({ kind: "file", path: p });
  };

  const remove = async () => {
    if (
      sel.kind !== "file" ||
      !(await ask({ text: `Delete ${sel.path}? It stays in the history.`, ok: "Delete" }))
    )
      return;
    try {
      await api(`/memory/file?path=${enc(sel.path)}`, { method: "DELETE" });
      toast(`Deleted ${sel.path}`);
      setConflict(null);
      setDoc(null);
      setHistPath("INDEX.md");
      setSel({ kind: "file", path: "INDEX.md" });
      bumpMemory();
    } catch (err) {
      toast(errorText(err, "Couldn't delete"), "error");
    }
  };

  const revert = async (c: Commit) => {
    if (!(await ask({ text: `Revert "${c.message}"?`, ok: "Revert" }))) return;
    try {
      const r = await api<{ sha: string | null }>(`/memory/revert/${c.sha}`, { body: {} });
      toast(
        r.sha ? `Reverted. New commit ${r.sha.slice(0, 7)}` : "Nothing to revert",
        r.sha ? "done" : "info",
      );
      bumpMemory();
    } catch (err) {
      toast(errorText(err, "Couldn't revert"), "error");
    }
  };

  const exists = sel.kind === "file" && files.some((f) => f.path === sel.path);
  const proposal = sel.kind === "proposal" ? allProposals[sel.id] : undefined;
  const skillName = sel.kind === "file" ? /^skills\/([^/]+)\.md$/.exec(sel.path)?.[1] : undefined;
  const skill = skills.find((s) => s.name === skillName);
  const troubled = skill ? new Set([...skill.failed, ...skill.takeovers]).size : 0;

  const failed = (err: unknown) => toast(errorText(err), "error");
  const tidy = () =>
    run(async () => {
      // It's worked out in the background now; the proposal arrives as an event.
      const p = await api<Proposal | { started: true } | null>("/proposals/tidy", { body: {} });
      if (p && "started" in p)
        toast("Tidying up. It shows under To look over when it's ready", "info");
      else if (p) {
        putProposal(p);
        void select({ kind: "proposal", id: p.id });
      } else toast("Nothing to tidy", "info");
    }, failed);
  const fixSkill = (name: string) =>
    run(async () => {
      const p = await api<Proposal | { started: true } | null>(`/skills/${name}/fix`, {
        body: {},
      });
      if (p && "started" in p)
        toast("Looking for a fix. It shows under To look over when it's ready", "info");
      else if (p) {
        putProposal(p);
        void select({ kind: "proposal", id: p.id });
      } else toast("No fix found in what went wrong", "info");
    }, failed);
  const recordAgain = async (name: string) => {
    try {
      await startTeach(name);
      navigate("/live");
    } catch (err) {
      toast(errorText(err, "Couldn't start recording"), "error");
    }
  };
  const answer = async (p: Proposal, how: "apply" | "dismiss") => {
    try {
      const r = await api<{ proposal: Proposal } | Proposal>(`/proposals/${p.id}/${how}`, {
        body: {},
      });
      putProposal("proposal" in r ? r.proposal : r);
      toast(how === "apply" ? "Applied" : "Dismissed");
      if (how === "apply") bumpMemory();
      void select({ kind: "file", path: p.changes[0]?.path ?? "INDEX.md" });
    } catch (err) {
      toast(errorText(err), "error");
    }
  };

  return (
    <section className="view">
      <div className="memory">
        <div className="tree">
          {groups.map(([dir, fs]) => (
            <div key={dir || "/"} style={{ display: "contents" }}>
              {dir && (
                <div className="folder">
                  <Icon name="folder" />
                  {dir}/
                </div>
              )}
              {fs.map((f) => (
                <button
                  type="button"
                  key={f.path}
                  className={sel.kind === "file" && sel.path === f.path ? "active" : ""}
                  aria-current={sel.kind === "file" && sel.path === f.path ? "page" : undefined}
                  onClick={() => select({ kind: "file", path: f.path })}
                >
                  <Icon name="file" />
                  {/* Phones show no folders: the chip says which INDEX.md it is. */}
                  {dir && <span className="tree-dir">{dir}/</span>}
                  {f.path.split("/").pop()}
                </button>
              ))}
            </div>
          ))}
          <button type="button" onClick={newFile}>
            <Icon name="plus" />
            New file
          </button>
          <button type="button" disabled={busy} onClick={tidy}>
            <Icon name="zap" />
            {busy ? "Thinking…" : "Tidy up"}
          </button>
          {pending.length > 0 && (
            <>
              <div className="folder">
                <Icon name="zap" />
                To look over
              </div>
              {pending.map((p) => (
                <button
                  type="button"
                  key={p.id}
                  className={sel.kind === "proposal" && sel.id === p.id ? "active" : ""}
                  onClick={() => select({ kind: "proposal", id: p.id })}
                >
                  <Icon name="file" />
                  {p.title}
                </button>
              ))}
            </>
          )}
          {drafts.length > 0 && (
            <>
              <div className="folder">
                <Icon name="teach" />
                Skill drafts
              </div>
              {drafts.map((d) => (
                <button type="button" key={d.id} onClick={() => navigate(`/memory/teach/${d.id}`)}>
                  <Icon name="file" />
                  {d.name ?? `Recording, ${dayTime(d.startedAt)}`}
                </button>
              ))}
            </>
          )}
        </div>

        <div className="editor">
          <div className="editor-bar">
            {sel.kind === "proposal" ? (
              <>
                <span className="path">{proposal?.title ?? "Proposal"}</span>
                <span className="spacer" />
                {proposal?.status === "pending" && (
                  <>
                    <button
                      type="button"
                      className="btn sm"
                      onClick={() => answer(proposal, "dismiss")}
                    >
                      Dismiss
                    </button>
                    <button
                      type="button"
                      className="btn sm accent"
                      onClick={() => answer(proposal, "apply")}
                    >
                      Apply
                    </button>
                  </>
                )}
              </>
            ) : sel.kind === "diff" ? (
              <>
                <span className="path">{sel.commit.sha.slice(0, 7)}</span>
                <span className="muted">
                  {sel.commit.author} · {sel.commit.message}
                </span>
                <span className="spacer" />
                <button
                  type="button"
                  className="btn sm"
                  onClick={() =>
                    select({
                      kind: "file",
                      path: sel.commit.files.includes(histPath)
                        ? histPath
                        : (sel.commit.files[0] ?? "INDEX.md"),
                    })
                  }
                >
                  Back to file
                </button>
                <button type="button" className="btn sm" onClick={() => revert(sel.commit)}>
                  <Icon name="undo" />
                  Revert
                </button>
              </>
            ) : (
              <>
                <span className="path">{sel.path}</span>
                <span className="spacer" />
                {exists && sel.path.endsWith(".md") && (
                  <button
                    type="button"
                    className="btn sm"
                    onClick={() => navigate(`/read?path=${enc(sel.path)}`)}
                  >
                    Read
                  </button>
                )}
                {exists && sel.path !== "INDEX.md" && (
                  <button type="button" className="btn sm ghost danger-text" onClick={remove}>
                    Delete
                  </button>
                )}
                <button
                  type="button"
                  className="btn sm accent"
                  disabled={!dirty || !!conflict}
                  onClick={() => save()}
                >
                  Save
                </button>
              </>
            )}
          </div>
          {sel.kind === "file" && conflict && (
            <div className="banner attn">
              <span>Changed while you were editing.</span>
              <span className="spacer" />
              <button type="button" className="btn sm" onClick={takeTheirs}>
                Reload
              </button>
              <button type="button" className="btn sm" onClick={() => save(conflict.sha)}>
                Overwrite
              </button>
            </div>
          )}
          {sel.kind === "file" && skill && troubled > 0 && (
            <div className="banner">
              <span>
                {troubled} of its {skill.runs} task{skill.runs === 1 ? "" : "s"} since it last
                changed {troubled === 1 ? "" : "each "}failed or needed you.
              </span>
              <span className="spacer" />
              <button
                type="button"
                className="btn sm"
                disabled={busy}
                onClick={() => fixSkill(skill.name)}
              >
                Suggest a fix
              </button>
              <button type="button" className="btn sm" onClick={() => recordAgain(skill.name)}>
                Record again
              </button>
            </div>
          )}
          {sel.kind === "proposal" ? (
            proposal ? (
              <ProposalView p={proposal} />
            ) : (
              <div className="empty">This proposal is gone.</div>
            )
          ) : sel.kind === "diff" ? (
            <div style={{ padding: "16px 20px" }}>
              <DiffView diff={diff} />
            </div>
          ) : doc?.path === sel.path && doc.state === "failed" ? (
            <LoadError error={doc.error ?? "Couldn't read it."} retry={() => read(sel.path)} />
          ) : doc?.path === sel.path && doc.state !== "loading" ? (
            <textarea
              className="editor-text"
              aria-label={sel.path}
              spellCheck={false}
              value={doc.content}
              onChange={(e) => {
                const content = e.target.value;
                setDoc((d) => d && { ...d, content });
              }}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "s") {
                  e.preventDefault();
                  if (dirty && !conflict) void save();
                }
              }}
            />
          ) : (
            <div className="editor-text" />
          )}
          <div className="history">
            <h3 className="section-title">History</h3>
            {shownHist?.error && (
              <LoadError error={shownHist.error} retry={() => setHistAttempt((n) => n + 1)} />
            )}
            {shownHist && !shownHist.error && shownHist.log.length === 0 && (
              <div className="muted">No changes yet.</div>
            )}
            {shownHist?.log.map((c) => (
              <div className="commit" key={c.sha}>
                <span className="sha">{c.sha.slice(0, 7)}</span>
                <div>
                  <div>{c.message}</div>
                  <div className="who">
                    {c.author} · {c.files.join(", ")} · {dayTime(c.date)}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 4 }}>
                  <button
                    type="button"
                    className="btn sm ghost"
                    onClick={() => select({ kind: "diff", commit: c })}
                  >
                    Diff
                  </button>
                  <button type="button" className="btn sm ghost" onClick={() => revert(c)}>
                    Revert
                  </button>
                </div>
              </div>
            ))}
            {shownHist?.older && (
              <button type="button" className="btn sm ghost load-earlier" onClick={loadOlder}>
                Older
              </button>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
