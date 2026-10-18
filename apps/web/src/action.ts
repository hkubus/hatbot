import { useState } from "react";
import { errorText } from "./api";

/**
 * What a button does: `busy` while it runs, and what went wrong as `error`, cleared each time it
 * starts. `fail` takes what went wrong instead, e.g. to say it in a toast.
 */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = async (fn: () => Promise<unknown>, fail?: (err: unknown) => void) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (err) {
      if (fail) fail(err);
      else setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, setError, run };
}
