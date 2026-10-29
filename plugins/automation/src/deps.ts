import type { Db, Hosts, PluginStore, Sandbox } from "@hatbot/plugin-sdk";
import { HATBOT_ID } from "@hatbot/shared";

export const NEEDS = [
  "tasks",
  "chats",
  "bots",
  "notifier",
  "events",
  "settings",
  "model",
  "spend",
  "memory",
  "storage",
  "plugins",
] satisfies (keyof Hosts)[];

export type Deps = Pick<Hosts, (typeof NEEDS)[number]> & {
  db: Db;
  desktop?: Sandbox;
  store: PluginStore;
  publicUrl: string;
  clock: () => number;
};

/** Clearing next_*_at means turning one back on works out when it's next due. */
export const OFF = {
  schedules: "enabled = 0, next_run_at = NULL",
  triggers: "enabled = 0",
  watchers: "enabled = 0, next_check_at = NULL",
};

/**
 * An automation its bot's reply made as the bot was deleted, which the move after it missed: it goes
 * to Hatbot switched off and doesn't run, since Hatbot may have plugins the bot didn't.
 */
export function orphaned(db: Db, table: keyof typeof OFF, id: number, botId: string): boolean {
  if (botId === HATBOT_ID) return false;
  if (db.query("SELECT 1 FROM bots WHERE id = ? AND deleted_at IS NULL").get(botId)) return false;
  db.query(`UPDATE ${table} SET bot_id = ?, ${OFF[table]} WHERE id = ?`).run(HATBOT_ID, id);
  console.log(`${table} ${id}: its bot ${botId} was deleted; moved to Hatbot, switched off`);
  return true;
}

/** A deleted bot's schedules, triggers and watchers go to Hatbot switched off. Returns the ids moved. */
export function moveFrom(db: Db, botId: string) {
  const move = (table: keyof typeof OFF) =>
    db
      .query<{ id: number }, [string, string]>(
        `UPDATE ${table} SET bot_id = ?, ${OFF[table]} WHERE bot_id = ? RETURNING id`,
      )
      .all(HATBOT_ID, botId)
      .map((r) => r.id);
  return db.transaction(() => ({
    schedules: move("schedules"),
    triggers: move("triggers"),
    watchers: move("watchers"),
  }))();
}

/** For LIKE: % and _ match themselves. */
export const like = (s: string) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
