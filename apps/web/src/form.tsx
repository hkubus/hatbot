import { useEffect, useState } from "react";

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

type Filled<F> = {
  form?: F;
  /** It's dirty while the form differs from this. */
  base?: F;
  seen?: F;
};

/** An update arriving while you type doesn't reset what you've written. */
export function refill<F>({ form, base, seen }: Filled<F>, seed: F | undefined): F | null {
  if (seed === undefined) return null;
  if (form === undefined) return seed;
  if (same(seed, seen)) return null;
  return same(form, base) || same(form, seed) ? seed : null;
}

/** What you typed while the save was on its way stays, unsaved. */
export function afterSave<F>(s: Filled<F>, sent: F, result: F): Filled<F> {
  return { form: same(s.form, sent) ? result : s.form, base: result, seen: result };
}

/** Kept in one order (the saved list's, then `all`'s), so switching one off and on again is a no-op. */
export function toggled(
  list: string[],
  id: string,
  on: boolean,
  saved: string[],
  all: string[],
): string[] {
  return [...new Set([...saved, ...all, ...list])].filter((x) =>
    x === id ? on : list.includes(x),
  );
}

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
    base,
    dirty,
    set: (patch: Partial<F>) =>
      setState((s) => (s.form ? { ...s, form: { ...s.form, ...patch } } : s)),
    fill: (f: F) => setState((s) => ({ ...s, form: f, base: f })),
    saved: (sent: F, result: F) => setState((s) => afterSave(s, sent, result)),
  };
}
