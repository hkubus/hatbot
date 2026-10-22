import { type DependencyList, useCallback, useEffect, useState } from "react";
import { ApiError, errorText } from "./api";
import { BackHead, Empty } from "./ui";

/** "Retry" for a load; a failed action says "Try again". */
export function LoadError({
  error,
  retry,
  label = "Retry",
}: {
  error: string;
  retry: () => void;
  label?: string;
}) {
  return (
    <div className="load-error">
      {error}
      <button type="button" className="btn sm" onClick={retry}>
        {label}
      </button>
    </div>
  );
}

/**
 * Loads again when a dep changes or on `retry`, keeping what it has meanwhile: a refresh that fails
 * leaves it showing. A 404 is `missing`, not an error.
 */
export function useLoad<T>(fn: () => Promise<T>, deps: DependencyList) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [missing, setMissing] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the caller's deps stand for `fn`
  useEffect(() => {
    let stale = false;
    setError("");
    fn().then(
      (d) => {
        if (stale) return;
        setData(d);
        setMissing(false);
      },
      (err) => {
        if (stale) return;
        if (err instanceof ApiError && err.status === 404) setMissing(true);
        else setError(errorText(err));
      },
    );
    return () => {
      stale = true;
    };
  }, [...deps, attempt]);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { data, setData, error, missing, retry };
}

export function useItem(id: number, fetch: (id: number) => Promise<unknown>) {
  const { error, missing, retry } = useLoad(() => fetch(id), [id, fetch]);
  return { missing, error, load: retry };
}

/** A whole page that hasn't loaded: what went wrong, or that it doesn't exist. */
export function PageLoad({
  error,
  retry,
  missing = "",
  back,
  wide,
}: {
  error: string;
  retry: () => void;
  missing?: string;
  back?: { label: string; to: string };
  wide?: boolean;
}) {
  return (
    <section className="view">
      <div className={wide ? "page" : "page narrow"}>
        {back && <BackHead to={back.to} label={back.label} />}
        {missing ? <Empty>{missing}</Empty> : error && <LoadError error={error} retry={retry} />}
      </div>
    </section>
  );
}
