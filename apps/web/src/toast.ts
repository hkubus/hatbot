import type { IconName } from "./icons";

export type ToastKind = "done" | "error" | "info";
export type Toast = (text: string, kind?: ToastKind) => void;

export const TOAST_ICON: Record<ToastKind, IconName | null> = {
  done: "check",
  error: "alert",
  info: null,
};
