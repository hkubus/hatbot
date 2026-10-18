import { useCallback, useEffect, useState } from "react";
import { ApiError, errorText } from "./api";

/** A page or list that didn't load: one plain line with Retry. */
export function LoadError({ error, retry }: { error: string; retry: () => void }) {
  return (
    <div className="load-error">
      {error}
      <button type="button" className="btn sm" onClick={retry}>
        Retry
      </button>
    </div>
  );
}

/**
 * Loads a page's one item into the store: `missing` once the brain says there's no such one, or
 * what went wrong, with `load` to try again.
 */
export function useItem(id: number, fetch: (id: number) => Promise<unknown>) {
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(() => {
    setError("");
    fetch(id).catch((err) => {
      if (err instanceof ApiError && err.status === 404) setMissing(true);
      else setError(errorText(err));
    });
  }, [id, fetch]);
  useEffect(load, [load]);
  return { missing, error, load };
}
