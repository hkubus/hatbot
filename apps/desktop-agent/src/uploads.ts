// Files the brain stages for one task (a listing's photos), where the browser can read them: Chromium
// runs as the same user as desktop-agent, and the shell's home is another user's.
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

/** A photo is a few MB; more than this isn't one. */
export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
/** Staged files go once their task ends, or after this, whichever comes first. */
export const UPLOAD_TTL_MS = 3600_000;

const STAGE = /^[a-z0-9-]{1,64}$/;
const NAME = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,99}$/;

export class UploadError extends Error {}

export function stagePath(root: string, stage: string): string {
  if (!STAGE.test(stage))
    throw new UploadError("stage must be lowercase letters, digits and dashes.");
  return join(root, stage);
}

export async function putUpload(root: string, stage: string, name: string, bytes: Uint8Array) {
  if (!NAME.test(name)) throw new UploadError("name must be letters, digits, dots, dashes and _.");
  const dir = stagePath(root, stage);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  await Bun.write(join(dir, name), bytes);
}

/** The staged files' paths, in the order given; each must be staged under `stage`. */
export function stagedPaths(root: string, stage: string, names: string[]): string[] {
  const dir = stagePath(root, stage);
  if (!names.length) throw new UploadError("No files were named.");
  return names.map((name) => {
    if (!NAME.test(name) || !existsSync(join(dir, name)))
      throw new UploadError(`${name} isn't staged for this task.`);
    return join(dir, name);
  });
}

export function dropUploads(root: string, stage: string) {
  rmSync(stagePath(root, stage), { recursive: true, force: true });
}

/** Removes stages last written to over UPLOAD_TTL_MS ago. */
export function sweepUploads(root: string, now = Date.now()) {
  if (!existsSync(root)) return;
  for (const stage of readdirSync(root)) {
    const dir = join(root, stage);
    try {
      if (now - statSync(dir).mtimeMs > UPLOAD_TTL_MS)
        rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
}
