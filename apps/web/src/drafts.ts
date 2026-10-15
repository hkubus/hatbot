// What you're writing in each chat. The text is kept in localStorage, so it outlasts a reload; files
// stay in memory while the app is open, uploads carrying on while you're in another chat.
import type { Attachment } from "@hatbot/shared";
import { useSyncExternalStore } from "react";

/** A file in the composer: uploading, uploaded, or failed. */
export type DraftFile = {
  key: number;
  name: string;
  preview?: string;
  attachment?: Attachment;
  error?: string;
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
