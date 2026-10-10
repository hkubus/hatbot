// The chat thread in folds (PLAN.md §5.3): each finished conversation folds up under its recap.
import type { Episode, ThreadMessage } from "./index";

export type ThreadGroup = {
  episodeId: number | null;
  messages: ThreadMessage[];
  /** What the fold says, for a finished conversation; null when it stays open. */
  fold: string | null;
};

const MAX_FALLBACK = 120;

/**
 * Messages in runs by conversation. Cards from background tasks have no conversation and join the one
 * before them. Every conversation but the last folds: a newer one has started, so it's finished. One
 * without a recap (from before recaps, or whose summary failed) shows its first message instead.
 */
export function threadGroups(
  messages: ThreadMessage[],
  episodes: Record<number, Episode | undefined>,
): ThreadGroup[] {
  const groups: ThreadGroup[] = [];
  for (const m of messages) {
    const last = groups.at(-1);
    const key = m.episodeId ?? last?.episodeId ?? null;
    if (last && last.episodeId === key) last.messages.push(m);
    else groups.push({ episodeId: key, messages: [m], fold: null });
  }
  groups.forEach((g, i) => {
    if (g.episodeId === null || i === groups.length - 1) return;
    const first =
      g.messages
        .find((m) => m.role === "user")
        ?.text.trim()
        .replace(/\s+/g, " ") ?? "";
    const fallback = first.length > MAX_FALLBACK ? `${first.slice(0, MAX_FALLBACK - 1)}…` : first;
    g.fold = episodes[g.episodeId]?.recap || fallback || "Earlier conversation";
  });
  return groups;
}

/**
 * Once a task has ended, its approvals fold into the message that shows it (the reply that started it,
 * or its card), so the thread keeps one message per task. Only when that message is loaded too. By
 * task: its approvals, oldest first.
 */
export function mergedApprovals(
  messages: ThreadMessage[],
  ended: (taskId: number) => boolean,
): Map<number, number[]> {
  const shown = new Set<number>();
  for (const m of messages) if (m.kind !== "approval" && m.taskId !== null) shown.add(m.taskId);
  const merged = new Map<number, number[]>();
  for (const m of messages) {
    if (m.kind !== "approval" || m.taskId === null || m.approvalId === null) continue;
    if (!shown.has(m.taskId) || !ended(m.taskId)) continue;
    merged.set(m.taskId, [...(merged.get(m.taskId) ?? []), m.approvalId]);
  }
  return merged;
}
