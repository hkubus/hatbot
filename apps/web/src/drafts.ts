// What you're writing in each chat. The text is kept in localStorage, so it outlasts a reload; files
// stay in memory while the app is open, uploads carrying on while you're in another chat.
import type { Attachment } from "@hatbot/shared";
import { useSyncExternalStore } from "react";
import { ApiError, upload } from "./api";

/** Types the page shows as pictures; the rest are links. */
export const PICTURES = ["image/jpeg", "image/png", "image/gif", "image/webp"];
/** The brain keeps files up to this size. */
const MAX_FILE = 25 * 1024 * 1024;

/** A file in the composer: uploading, uploaded, or failed. */
export type DraftFile = {
  key: number;
  name: string;
  preview?: string;
  attachment?: Attachment;
  error?: string;
  /** Stops its upload when it's taken off. */
  abort?: AbortController;
};

// Incognito keeps nothing, so its text stays in memory too.
const memoryText = new Map<string, string>();
const stored = (chat: string) => !chat.endsWith(":incognito");
const textKey = (chat: string) => `hatbot:draft:${chat}`;

export function draftText(chat: string): string {
  if (!stored(chat)) return memoryText.get(chat) ?? "";
  try {
    return localStorage.getItem(textKey(chat)) ?? "";
  } catch {
    return "";
  }
}

export function saveDraftText(chat: string, text: string) {
  if (!stored(chat)) {
    if (text) memoryText.set(chat, text);
    else memoryText.delete(chat);
    return;
  }
  try {
    if (text) localStorage.setItem(textKey(chat), text);
    else localStorage.removeItem(textKey(chat));
  } catch {
    // Full or blocked storage: the draft just isn't kept.
  }
}

const NONE: DraftFile[] = [];
const files = new Map<string, DraftFile[]>();
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export const draftFiles = (chat: string) => files.get(chat) ?? NONE;

export function setDraftFiles(chat: string, fn: (list: DraftFile[]) => DraftFile[]) {
  const next = fn(draftFiles(chat));
  if (next.length) files.set(chat, next);
  else files.delete(chat);
  for (const l of listeners) l();
}

export function useDraftFiles(chat: string): DraftFile[] {
  return useSyncExternalStore(subscribe, () => draftFiles(chat));
}

let fileKey = 0;
/** Adds files to a chat's draft and uploads them; one too big is shown failed rather than sent. */
export function attachFiles(chat: string, list: FileList | File[]) {
  for (const file of Array.from(list).slice(0, 10)) {
    const key = ++fileKey;
    if (file.size > MAX_FILE) {
      setDraftFiles(chat, (f) => [...f, { key, name: file.name, error: "Over 25 MB." }]);
      continue;
    }
    const preview = PICTURES.includes(file.type) ? URL.createObjectURL(file) : undefined;
    const abort = new AbortController();
    setDraftFiles(chat, (f) => [...f, { key, name: file.name, preview, abort }]);
    const put = (patch: Partial<DraftFile>) =>
      setDraftFiles(chat, (f) => f.map((d) => (d.key === key ? { ...d, ...patch } : d)));
    upload(file, abort.signal).then(
      (attachment) => put({ attachment, abort: undefined }),
      (err) => {
        if (abort.signal.aborted) return;
        put({
          error: err instanceof ApiError ? err.message : "Couldn't upload.",
          abort: undefined,
        });
      },
    );
  }
}

/** Forgets every chat's draft, for signing out: its text, and files still uploading or waiting. */
export function clearDrafts() {
  memoryText.clear();
  try {
    const keys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i));
    for (const key of keys) if (key?.startsWith("hatbot:draft:")) localStorage.removeItem(key);
  } catch {
    // Blocked storage kept nothing.
  }
  for (const list of files.values())
    for (const d of list) {
      d.abort?.abort();
      if (d.preview) URL.revokeObjectURL(d.preview);
    }
  files.clear();
  for (const l of listeners) l();
}

/** Takes a file off a chat's draft, stopping its upload if it's still going. */
export function removeFile(chat: string, key: number) {
  setDraftFiles(chat, (f) => {
    const d = f.find((x) => x.key === key);
    d?.abort?.abort();
    if (d?.preview) URL.revokeObjectURL(d.preview);
    return f.filter((x) => x.key !== key);
  });
}
