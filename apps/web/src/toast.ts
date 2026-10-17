import type { IconName } from "./icons";

/** What a toast says: something done, something that failed, or plain news. */
export type ToastKind = "done" | "error" | "info";
export type Toast = (text: string, kind?: ToastKind) => void;

/** A check for done, an alert (in red) for an error, nothing for news. */
export const TOAST_ICON: Record<ToastKind, IconName | null> = {
  done: "check",
  error: "alert",
  info: null,
};
