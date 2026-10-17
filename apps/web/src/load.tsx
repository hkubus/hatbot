import { errorText } from "./api";

/** What went wrong loading something, in a few words. */
export const loadErrorText = (err: unknown) => errorText(err, "Can't reach Hatbot.");

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
