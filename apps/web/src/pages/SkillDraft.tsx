// Teach-by-showing's review step (PLAN.md §10.5): the skill Opus drafted from your recording, to edit and save.
import { useEffect, useState } from "react";
import { useAction } from "../action";
import { ApiError } from "../api";
import { ask, useLeaveGuard } from "../confirm";
import { navigate } from "../router";
import { discardTeach, loadTeach, redraftTeach, saveSkill, useStore } from "../store";
import { BackButton, BackHead } from "../ui";

const NAME = /^[a-z0-9][a-z0-9-]{0,59}$/;

export function SkillDraft({ id, toast }: { id: number; toast: (t: string) => void }) {
  const session = useStore((s) => s.teach[id]);
  const [missing, setMissing] = useState(false);
  const [name, setName] = useState("");
  const [content, setContent] = useState("");
  const { busy, error, run } = useAction();

  useEffect(() => {
    loadTeach(id).catch(() => setMissing(true));
  }, [id]);

  // Fill the editor when the draft arrives, without overwriting your edits.
  const draft = session?.status === "draft" ? session.draft : null;
  useEffect(() => {
    if (draft === null) return;
    setContent(draft);
    setName(session?.name ?? "");
  }, [draft, session?.name]);
  const release = useLeaveGuard(
    draft !== null && (content !== draft || name !== (session?.name ?? "")),
  );

  if (missing) return <div className="empty">This recording doesn't exist.</div>;
  if (!session) return <section className="view" />;

  const save = () =>
    run(async () => {
      let path: string;
      try {
        path = await saveSkill(id, { name, content });
      } catch (err) {
        if (!(err instanceof ApiError && err.status === 409 && err.message.includes("already")))
          throw err;
        if (!(await ask({ text: `${err.message} Replace it?`, ok: "Replace" }))) return;
        path = await saveSkill(id, { name, content, replace: true });
      }
      toast(`Saved ${path}`);
    });

  const discard = async () => {
    if (await ask({ text: "Throw this draft away?", ok: "Throw away" }))
      void run(async () => {
        await discardTeach(id);
        release();
        navigate("/memory");
      });
  };

  if (session.status === "draft")
    return (
      <section className="view">
        <div className="editor">
          <div className="editor-bar">
            <BackButton to="/memory" label="Memory" />
            <span className="path">skills/</span>
            <input
              className="field mono"
              aria-label="Skill name"
              value={name}
              maxLength={60}
              onChange={(e) => setName(e.target.value.toLowerCase())}
            />
            <span className="path">.md</span>
            <span className="spacer" />
            <button type="button" className="btn sm ghost danger-text" onClick={discard}>
              Discard
            </button>
            <button
              type="button"
              className="btn sm accent"
              disabled={busy || !NAME.test(name) || !content.trim()}
              onClick={save}
            >
              Save skill
            </button>
          </div>
          {error && <div className="form-error">{error}</div>}
          <textarea
            className="editor-text"
            aria-label={name ? `skills/${name}.md` : "Skill"}
            spellCheck={false}
            value={content}
            onChange={(e) => setContent(e.target.value)}
          />
        </div>
      </section>
    );

  return (
    <section className="view">
      <div className="page narrow">
        <BackHead to="/memory" label="Memory" />
        <div className="panel">
          {session.status === "recording" && <p>Still recording. Stop it from the live view.</p>}
          {session.status === "drafting" && <p>Writing the skill from your recording…</p>}
          {session.status === "failed" && <p>{session.error}</p>}
          {session.status === "saved" && (
            <p>
              Saved as{" "}
              <button
                type="button"
                className="text-link"
                onClick={() => navigate(`/memory?path=skills/${session.name}.md`)}
              >
                skills/{session.name}.md
              </button>
              .
            </p>
          )}
          {session.status === "discarded" && <p>Discarded.</p>}
          {error && <div className="form-error">{error}</div>}
          {(session.status === "failed" || session.status === "drafting") && (
            <div className="form-actions">
              <button type="button" className="btn sm ghost danger-text" onClick={discard}>
                Discard
              </button>
              {session.status === "failed" && session.steps > 0 && (
                <button
                  type="button"
                  className="btn sm accent"
                  disabled={busy}
                  onClick={() => run(() => redraftTeach(id))}
                >
                  Try again
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
