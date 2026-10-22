import type { Task } from "./index";

/** Marks around the matched words in a snippet: render the text between them highlighted. */
export const MATCH_START = "\u0002";
export const MATCH_END = "\u0003";

export type MessageHit = {
  id: number;
  conversationId: number;
  /** Who wrote it: null for you. */
  botId: string | null;
  snippet: string;
  createdAt: string;
};

export type MemoryHit = { path: string; line: number; text: string };

export type RoutineHit = { kind: "schedule" | "trigger" | "watcher"; id: number; name: string };

export type SearchResults = {
  query: string;
  messages: MessageHit[];
  tasks: Task[];
  memory: MemoryHit[];
  routines: RoutineHit[];
};
