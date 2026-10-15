import type { Commit, MemoryFile, Proposal, SkillStatus } from "@hatbot/shared";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiError, api } from "../api";
import { lineDiff } from "../diff";
import { Icon } from "../icons";
import { navigate } from "../router";
import { bumpMemory, loadProposals, putProposal, startTeach, useStore } from "../store";

type Selection =
  | { kind: "file"; path: string }
  | { kind: "diff"; commit: Commit }
  | { kind: "proposal"; id: number };

const enc = encodeURIComponent;
const when = (iso: string) =>
  new Date(iso).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

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

/** A proposal's changes, file by file, with why. */
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

export function Memory({ toast, open }: { toast: (t: string) => void; open?: string }) {
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
  const [busy, setBusy] = useState(false);
  const teach = useStore((s) => s.teach);
  const drafts = useMemo(
    () =>
      Object.values(teach)
        .filter((t) => t.status === "drafting" || t.status === "draft" || t.status === "failed")
        .sort((a, b) => b.id - a.id),
    [teach],
  );
  const [files, setFiles] = useState<MemoryFile[]>([]);
  const [log, setLog] = useState<Commit[]>([]);
  const [sel, setSel] = useState<Selection>({ kind: "file", path: open || "INDEX.md" });
  const [content, setContent] = useState("");
  const [saved, setSaved] = useState("");
  const [diff, setDiff] = useState("");

  const dirty = sel.kind === "file" && content !== saved;

  // biome-ignore lint/correctness/useExhaustiveDependencies: reload when memory changes anywhere
  useEffect(() => {
    api<MemoryFile[]>("/memory/tree").then(setFiles);
    api<Commit[]>("/memory/log?limit=50").then(setLog);
    api<SkillStatus[]>("/skills").then(setSkills, () => setSkills([]));
  }, [version]);
  useEffect(() => {
    void loadProposals().catch(() => {});
  }, []);

  const openFile = useCallback(
    (path: string) => {
      if (dirty && !confirm("Discard your unsaved changes?")) return;
      setSel({ kind: "file", path });
    },
    [dirty],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: reload the open file when memory changes, unless you're editing it
  useEffect(() => {
    if (sel.kind !== "file" || dirty) return;
    api<{ content: string }>(`/memory/file?path=${enc(sel.path)}`).then(
      (r) => {
        setContent(r.content);
        setSaved(r.content);
      },
      () => {
        setContent("");
        setSaved("");
      },
    );
  }, [sel, version]);

  useEffect(() => {
    if (sel.kind === "diff")
      api<{ diff: string }>(`/memory/diff/${sel.commit.sha}`).then((r) => setDiff(r.diff));
  }, [sel]);

  const groups = useMemo(() => {
    const g = new Map<string, MemoryFile[]>();
    for (const f of files) {
      const dir = f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : "";
      g.set(dir, [...(g.get(dir) ?? []), f]);
    }
    return [...g].sort(([a], [b]) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)));
  }, [files]);

  const save = async () => {
    if (sel.kind !== "file") return;
    try {
      const r = await api<{ sha: string | null }>(`/memory/file?path=${enc(sel.path)}`, {
        method: "PUT",
        body: { content, message: `Edit ${sel.path}` },
      });
      setSaved(content);
      toast(r.sha ? `Saved (${r.sha.slice(0, 7)})` : "No changes");
      bumpMemory();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Couldn't save");
    }
  };

  const newFile = () => {
    const path = prompt("New file path, e.g. projects/garden.md")?.trim();
    if (!path) return;
    const p = path.endsWith(".md") ? path : `${path}.md`;
    setSel({ kind: "file", path: p });
    const title = p.split("/").pop()?.replace(/\.md$/, "").replace(/-/g, " ") ?? "";
    setContent(`# ${title.charAt(0).toUpperCase()}${title.slice(1)}\n`);
    setSaved("");
  };

  const remove = async () => {
    if (sel.kind !== "file" || !confirm(`Delete ${sel.path}? It stays in the history.`)) return;
    try {
      await api(`/memory/file?path=${enc(sel.path)}`, { method: "DELETE" });
      toast(`Deleted ${sel.path}`);
      setSel({ kind: "file", path: "INDEX.md" });
      bumpMemory();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Couldn't delete");
    }
  };

  const revert = async (c: Commit) => {
    if (!confirm(`Revert "${c.message}"?`)) return;
    try {
      const r = await api<{ sha: string | null }>(`/memory/revert/${c.sha}`, { body: {} });
      toast(r.sha ? `Reverted. New commit ${r.sha.slice(0, 7)}` : "Nothing to revert");
      bumpMemory();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Couldn't revert");
    }
  };

  const exists = sel.kind === "file" && files.some((f) => f.path === sel.path);
  const proposal = sel.kind === "proposal" ? allProposals[sel.id] : undefined;
  const skillName = sel.kind === "file" ? /^skills\/([^/]+)\.md$/.exec(sel.path)?.[1] : undefined;
  const skill = skills.find((s) => s.name === skillName);
  const troubled = skill ? new Set([...skill.failed, ...skill.takeovers]).size : 0;

  const tidy = async () => {
    setBusy(true);
    try {
      const p = await api<Proposal | null>("/proposals/tidy", { body: {} });
      if (p) {
        putProposal(p);
        setSel({ kind: "proposal", id: p.id });
      } else toast("Nothing to tidy");
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Couldn't reach Hatbot");
    }
    setBusy(false);
  };
  const fixSkill = async (name: string) => {
    setBusy(true);
    try {
      const p = await api<Proposal | null>(`/skills/${name}/fix`, { body: {} });
      if (p) {
        putProposal(p);
        setSel({ kind: "proposal", id: p.id });
      } else toast("No fix found in what went wrong");
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Couldn't reach Hatbot");
    }
    setBusy(false);
  };
  const recordAgain = async (name: string) => {
    try {
      await startTeach(name);
      navigate("/live");
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Couldn't start recording");
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
      setSel({ kind: "file", path: p.changes[0]?.path ?? "INDEX.md" });
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Couldn't reach Hatbot");
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
                  onClick={() => openFile(f.path)}
                >
                  <Icon name="file" />
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
                  onClick={() => setSel({ kind: "proposal", id: p.id })}
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
                  {d.name ?? `Recording, ${when(d.startedAt)}`}
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
                  onClick={() => setSel({ kind: "file", path: sel.commit.files[0] ?? "INDEX.md" })}
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
                {exists && sel.path !== "INDEX.md" && (
                  <button type="button" className="btn sm ghost danger-text" onClick={remove}>
                    Delete
                  </button>
                )}
                <button type="button" className="btn sm accent" disabled={!dirty} onClick={save}>
                  Save
                </button>
              </>
            )}
          </div>
          {sel.kind === "file" && skill && troubled > 0 && (
            <div className="skill-trouble">
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
          ) : (
            <textarea
              className="editor-text"
              spellCheck={false}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "s") {
                  e.preventDefault();
                  if (dirty) void save();
                }
              }}
            />
          )}
          <div className="history">
            <h3 className="section-title">History</h3>
            {log.map((c) => (
              <div className="commit" key={c.sha}>
                <span className="sha">{c.sha.slice(0, 7)}</span>
                <div>
                  <div>{c.message}</div>
                  <div className="who">
                    {c.author} · {c.files.join(", ")} · {when(c.date)}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 4 }}>
                  <button
                    type="button"
                    className="btn sm ghost"
                    onClick={() => setSel({ kind: "diff", commit: c })}
                  >
                    Diff
                  </button>
                  <button type="button" className="btn sm ghost" onClick={() => revert(c)}>
                    Revert
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
