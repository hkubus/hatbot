// Not the browser's confirm(): it can't show a red button, and looks like the page went wrong.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { setLeaveGuard } from "./router";

type Question = {
  text: string;
  ok: string;
  cancel: string;
  danger: boolean;
  input?: string;
  answer: (value: string | null) => void;
};

let open: Question | null = null;
let hosts = 0;
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const show = (q: Question | null) => {
  open = q;
  for (const l of listeners) l();
};

function put(q: Omit<Question, "answer">): Promise<string | null> {
  return new Promise((resolve) => {
    // One at a time: a second ask while one is showing (Back pressed under it) is a no.
    if (open) return resolve(null);
    if (!hosts) {
      // Nothing on screen to ask with.
      if (q.input === undefined) return resolve(window.confirm(q.text) ? "" : null);
      return resolve(window.prompt(q.text)?.trim() || null);
    }
    show({
      ...q,
      answer: (value) => {
        show(null);
        resolve(value);
      },
    });
  });
}

/** Red unless `danger` is false. */
export async function ask(o: {
  text: string;
  ok: string;
  cancel?: string;
  danger?: boolean;
}): Promise<boolean> {
  const r = await put({ cancel: "Cancel", danger: true, ...o });
  return r !== null;
}

export function askText(o: {
  text: string;
  ok: string;
  placeholder: string;
}): Promise<string | null> {
  return put({ text: o.text, ok: o.ok, cancel: "Cancel", danger: false, input: o.placeholder });
}

/** Its result drops the guard at once, for leaving right after a save or a delete. */
export function useLeaveGuard(dirty: boolean): () => void {
  const off = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!dirty) return;
    const unset = setLeaveGuard(() =>
      ask({ text: "Leave without saving your changes?", ok: "Leave" }),
    );
    const onUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", onUnload);
    const stop = () => {
      unset();
      window.removeEventListener("beforeunload", onUnload);
      off.current = null;
    };
    off.current = stop;
    return stop;
  }, [dirty]);
  return useCallback(() => off.current?.(), []);
}

/** Shows what ask() and askText() ask. Rendered once, beside the app. */
export function Dialogs() {
  const q = useSyncExternalStore(subscribe, () => open);
  const ref = useRef<HTMLDialogElement>(null);
  // Still shown while it shrinks away.
  const last = useRef(q);
  if (q) last.current = q;
  const shown = q ?? last.current;
  const [value, setValue] = useState("");
  useEffect(() => {
    hosts++;
    return () => {
      hosts--;
    };
  }, []);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (q && !d.open) {
      setValue("");
      d.showModal();
      // A destructive one starts on Cancel, the first button; one with a field, in the field.
      d.querySelector("input")?.focus();
    } else if (!q && d.open) d.close();
  }, [q]);

  return (
    <dialog
      ref={ref}
      className="ask"
      aria-label={q?.text}
      onCancel={(e) => {
        e.preventDefault();
        q?.answer(null);
      }}
    >
      {shown && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (shown.input === undefined) shown.answer("");
            else if (value.trim()) shown.answer(value.trim());
          }}
        >
          <p>{shown.text}</p>
          {shown.input !== undefined && (
            <input
              className="field"
              value={value}
              placeholder={shown.input}
              aria-label={shown.text}
              spellCheck={false}
              onChange={(e) => setValue(e.target.value)}
            />
          )}
          <div className="ask-actions">
            <button type="button" className="btn" onClick={() => shown.answer(null)}>
              {shown.cancel}
            </button>
            <button
              type="submit"
              className={`btn ${shown.danger ? "danger" : "accent"}`}
              disabled={shown.input !== undefined && !value.trim()}
            >
              {shown.ok}
            </button>
          </div>
        </form>
      )}
    </dialog>
  );
}
