// Search across chats, tasks, memory, and what runs on its own.
import type { Task } from "./index";

/** Marks around the matched words in a snippet: render the text between them highlighted. */
export const MATCH_START = "\u0002";
export const MATCH_END = "\u0003";

export type MessageHit = {
  id: number;
  conversationId: number;
  /** Who wrote it: null for you. */
  botId: string | null;
  /** The text around the match, with MATCH_START/MATCH_END around the matched words. */
  snippet: string;
  createdAt: string;
};

export type MemoryHit = { path: string; line: number; text: string };

/** A schedule, trigger or watcher whose name or instructions match. */
export type RoutineHit = { kind: "schedule" | "trigger" | "watcher"; id: number; name: string };

export type SearchResults = {
  query: string;
  messages: MessageHit[];
  tasks: Task[];
  memory: MemoryHit[];
  routines: RoutineHit[];
};
