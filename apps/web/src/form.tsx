// Edit pages: a form filled from what's stored, and what to show when there's nothing to fill it from.
import { useEffect, useState } from "react";
import { Icon } from "./icons";
import { LoadError } from "./load";

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

type Filled<F> = {
  form?: F;
  /** What the form was last filled with: it's dirty while it differs. */
  base?: F;
  /** The stored values it was last filled from. */
  seen?: F;
};

/**
 * The form once the stored values are `seed`, or null to leave it: filled the first time, then
 * from a newer stored value only while you have no unsaved edits, or once it's caught up with them
 * (your save came back). An update arriving while you type doesn't reset what you've written.
 */
export function refill<F>({ form, base, seen }: Filled<F>, seed: F | undefined): F | null {
  if (seed === undefined) return null;
  if (form === undefined) return seed;
  if (same(seed, seen)) return null;
  return same(form, base) || same(form, seed) ? seed : null;
}

/**
 * A form, `dirty` while it differs from what it was last filled with. `seed` is the stored item as
 * the form holds it (undefined until it's loaded); `fill` fills it from something else, e.g. a
 * template.
 */
export function useStoredForm<F>(seed: F | undefined) {
  const [state, setState] = useState<Filled<F>>(() => ({ form: seed, base: seed, seen: seed }));
  const { form, base } = state;
  const dirty = form !== undefined && !same(form, base);
  const key = seed === undefined ? undefined : JSON.stringify(seed);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for `seed`; again once you've undone your edits
  useEffect(() => {
    const next = refill(state, seed);
    if (next !== null) setState({ form: next, base: next, seen: seed });
  }, [key, dirty]);
  return {
    form,
    dirty,
    set: (patch: Partial<F>) =>
      setState((s) => (s.form ? { ...s, form: { ...s.form, ...patch } } : s)),
    fill: (f: F) => setState((s) => ({ ...s, form: f, base: f })),
  };
}

/** An edit page with nothing to edit yet: why, with Back, and Retry when loading failed. */
export function NoForm({
  error,
  missing,
  retry,
  back,
}: {
  error: string;
  /** Set once the list has loaded without it, e.g. "This bot doesn't exist." */
  missing: string;
  retry: () => void;
  back: { label: string; go: () => void };
}) {
  return (
    <section className="view">
      <div className="page narrow">
        <div className="page-head">
          <button type="button" className="btn sm ghost back" onClick={back.go}>
            <Icon name="chevron" />
            {back.label}
          </button>
        </div>
        {missing ? (
          <div className="empty">{missing}</div>
        ) : (
          error && <LoadError error={error} retry={retry} />
        )}
      </div>
    </section>
  );
}
