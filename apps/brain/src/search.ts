import { MATCH_END, MATCH_START, type MessageHit, type SearchResults } from "@hatbot/shared";
import { LISTED_CHAT } from "./agent/chats";
import type { Db } from "./db";
import type { MemoryStore } from "./memory/store";
import type { Plugins } from "./plugins/registry";
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
  d: { db: Db; tasks: Tasks; memory: MemoryStore; plugins: Pick<Plugins, "search"> },
  query: string,
): Promise<SearchResults> {
  const q = query.trim();
  const empty: SearchResults = { query: q, messages: [], tasks: [], memory: [], routines: [] };
  if (!q) return empty;
  const fts = ftsQuery(q);
  const pattern = like(q);
  const [messages, memory] = await Promise.all([
    // Incognito messages aren't in the index, so they can't be found. A chat that's gone from the
    // list, a deleted group or a deleted bot's own, isn't searched either: its results lead nowhere.
    fts ? hitMessages(d.db, fts) : [],
    d.memory.search(q, LIMIT),
  ]);
  const tasks = d.tasks.list({ like: pattern, limit: LIMIT });
  const routines = d.plugins
    .search(q)
    .sort((x, y) => x.name.localeCompare(y.name, undefined, { sensitivity: "base" }));
  return { ...empty, messages, tasks, memory, routines };
}
type Found = {
  id: number;
  conversation_id: number;
  bot_id: string | null;
  role: string;
  created_at: string;
  snippet: string;
};

/**
 * The matches, newest first. Not by FTS5's rank: that reads every match in turn, scoring each from
 * the words' places in all the messages before it, which over a long history is most of what a
 * search costs. Nor snippets for every match, which read them all too; only for the ones shown.
 */
function hitMessages(db: Db, fts: string): MessageHit[] {
  db.exec("CREATE TABLE IF NOT EXISTS temp.search_found (id INTEGER PRIMARY KEY)");
  return db.transaction(() => {
    db.exec("DELETE FROM temp.search_found");
    // The chat itself too: a deleted group's messages are still indexed until it's swept.
    db.query(
      `INSERT INTO temp.search_found (id) SELECT f.rowid FROM messages_fts f
       JOIN messages m ON m.id = f.rowid
       JOIN conversations c ON c.id = m.conversation_id
       WHERE messages_fts MATCH ? AND ${LISTED_CHAT}
       ORDER BY f.rowid DESC LIMIT ?`,
    ).run(fts, LIMIT);
    return db
      .query<
        Found,
        [string, string, string]
      >(`SELECT m.id, m.conversation_id, m.bot_id, m.role, m.created_at,
         snippet(messages_fts, 0, ?, ?, '…', 24) AS snippet
        FROM temp.search_found s JOIN messages m ON m.id = s.id
        JOIN messages_fts f ON f.rowid = m.id AND messages_fts MATCH ?
        ORDER BY m.id DESC`)
      .all(MATCH_START, MATCH_END, fts)
      .map((r) => ({
        id: r.id,
        conversationId: r.conversation_id,
        botId: r.role === "user" ? null : r.bot_id,
        snippet: r.snippet,
        createdAt: r.created_at,
      }));
  })();
}
