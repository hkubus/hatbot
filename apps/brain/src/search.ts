import { MATCH_END, MATCH_START, type SearchResults } from "@hatbot/shared";
import { LISTED_CHAT } from "./agent/chats";
import type { Db } from "./db";
import type { MemoryStore } from "./memory/store";
import type { Tasks } from "./tasks/service";

const LIMIT = 30;

/**
 * Words for FTS5, each quoted; the last one also matches as a prefix, so results come while typing.
 * All of them must match, or with `join` " OR ", any.
 */
export function ftsQuery(query: string, join = " "): string | null {
  const terms = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
  if (!terms.length) return null;
  return terms.map((t, i) => `"${t}"${i === terms.length - 1 ? "*" : ""}`).join(join);
}

/** For LIKE: % and _ match themselves. */
const like = (s: string) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export async function search(
  d: { db: Db; tasks: Tasks; memory: MemoryStore },
  query: string,
): Promise<SearchResults> {
  const q = query.trim();
  const empty: SearchResults = { query: q, messages: [], tasks: [], memory: [], routines: [] };
  if (!q) return empty;
  const fts = ftsQuery(q);
  // Incognito messages aren't in the index, so they can't be found. A chat that's gone from the list,
  // a deleted group or a deleted bot's own, isn't searched either: its results would lead nowhere.
  const messages = fts
    ? d.db
        .query<
          {
            id: number;
            conversation_id: number;
            bot_id: string | null;
            role: string;
            snippet: string;
            created_at: string;
          },
          [string, string, string, number]
        >(
          `SELECT m.id, m.conversation_id, m.bot_id, m.role, m.created_at,
             snippet(messages_fts, 0, ?, ?, '…', 24) AS snippet
           FROM messages_fts f JOIN messages m ON m.id = f.rowid JOIN conversations c ON c.id = m.conversation_id
           WHERE messages_fts MATCH ? AND ${LISTED_CHAT} ORDER BY rank LIMIT ?`,
        )
        .all(MATCH_START, MATCH_END, fts, LIMIT)
        .map((r) => ({
          id: r.id,
          conversationId: r.conversation_id,
          botId: r.role === "user" ? null : r.bot_id,
          snippet: r.snippet,
          createdAt: r.created_at,
        }))
    : [];
  const pattern = like(q);
  const tasks = d.tasks.list({ like: pattern, limit: LIMIT });
  const routines = d.db
    .query<{ kind: "schedule" | "trigger" | "watcher"; id: number; name: string }, string[]>(
      `SELECT 'schedule' AS kind, id, name FROM schedules WHERE name LIKE ?1 ESCAPE '\\' OR prompt LIKE ?1 ESCAPE '\\'
       UNION ALL SELECT 'trigger', id, name FROM triggers WHERE name LIKE ?1 ESCAPE '\\' OR prompt LIKE ?1 ESCAPE '\\'
       UNION ALL SELECT 'watcher', id, name FROM watchers
         WHERE name LIKE ?1 ESCAPE '\\' OR prompt LIKE ?1 ESCAPE '\\' OR source LIKE ?1 ESCAPE '\\'
       ORDER BY name`,
    )
    .all(pattern);
  return { ...empty, messages, tasks, memory: await d.memory.search(q, LIMIT), routines };
}
