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
 * without a recap (from before recaps, or whose summary failed) shows your first message instead.
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
        .find((m) => m.role === "user" && m.kind !== "command")
        ?.text.trim()
        .replace(/\s+/g, " ") ?? "";
    const fallback = first.length > MAX_FALLBACK ? `${first.slice(0, MAX_FALLBACK - 1)}…` : first;
    g.fold = episodes[g.episodeId]?.recap || fallback || "Earlier conversation";
  });
  return groups;
}

/** Chat commands: the brain runs them itself, without the model. */
export const CHAT_COMMANDS = [
  { name: "new", args: "", description: "Start a new conversation" },
  { name: "stop", args: "[task number]", description: "Stop the reply, or a task" },
  { name: "task", args: "<what to do>", description: "Run it as a background task" },
  { name: "remember", args: "<fact>", description: "Save it to memory as written" },
] as const;

export type ChatCommand = { name: (typeof CHAT_COMMANDS)[number]["name"]; arg: string };

/** "/task fix CI" → { name: "task", arg: "fix CI" }. Anything else, "/etc/hosts" included, is a message. */
export function parseCommand(text: string): ChatCommand | null {
  const m = /^\/([a-z]+)(?:\s+([\s\S]*))?$/i.exec(text.trim());
  const name = m?.[1]?.toLowerCase();
  const command = CHAT_COMMANDS.find((c) => c.name === name);
  return command ? { name: command.name, arg: m?.[2]?.trim() ?? "" } : null;
}

/** The commands a composer's "/…" could mean, while you type the name. */
export function matchingCommands(text: string): (typeof CHAT_COMMANDS)[number][] {
  const m = /^\/([a-z]*)$/i.exec(text);
  if (!m) return [];
  const typed = (m[1] ?? "").toLowerCase();
  return CHAT_COMMANDS.filter((c) => c.name.startsWith(typed));
}
