const KEY = "hatbot:reloaded";

/**
 * Reloads the page to load the new build (after an Update the old build's chunks are gone), unless
 * it did so in the last 30 s: a chunk that's really missing mustn't reload the page for ever.
 */
export function reloadOnce(
  storage: Pick<Storage, "getItem" | "setItem"> = sessionStorage,
  now = Date.now(),
  reload = () => location.reload(),
): boolean {
  try {
    if (now - Number(storage.getItem(KEY) ?? 0) < 30_000) return false;
    storage.setItem(KEY, String(now));
  } catch {
    return false;
  }
  reload();
  return true;
}
