// Your bots (PLAN.md §14): each has its own role, chat, memory folder, plugins and browser profile.
// Hatbot is the first, and can't be deleted.

import type { CreateBot, UpdateBot } from "@hatbot/shared";
import { BOT_COLORS, type Bot, HATBOT_ID } from "@hatbot/shared";
import type { z } from "zod";
import type { Db } from "./db";
import type { EventBus } from "./events";
import { type Author, HATBOT } from "./memory/store";

type Row = {
  id: string;
  name: string;
  icon: Bot["icon"];
  color: Bot["color"];
  instructions: string;
  chat_model: Bot["chatModel"];
  chat_effort: Bot["chatEffort"];
  plugins: string | null;
  created_at: string;
};

const toBot = (r: Row): Bot => ({
  id: r.id,
  name: r.name,
  icon: r.icon,
  color: r.color,
  instructions: r.instructions,
  chatModel: r.chat_model,
  chatEffort: r.chat_effort,
  plugins: r.plugins === null ? null : (JSON.parse(r.plugins) as string[]),
  createdAt: r.created_at,
});

export class BotError extends Error {}

/** What a deleted bot's schedules, triggers and watchers were: they're Hatbot's now. */
export type Moved = { schedules: number[]; triggers: number[]; watchers: number[] };

/** A bot's id from its name: "Home lab" → "home-lab". */
export function slugOf(name: string): string {
  const slug = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24)
    .replace(/-+$/, "");
  return /^[a-z]/.test(slug) ? slug : `bot-${slug}`.replace(/-+$/, "");
}

export class Bots {
  constructor(
    private db: Db,
    private events: EventBus,
    private clock: () => number = Date.now,
  ) {}

  /** Bots that aren't deleted, Hatbot first, then in the order they were made. */
  list(): Bot[] {
    return this.db
      .query<Row, []>(
        "SELECT * FROM bots WHERE deleted_at IS NULL ORDER BY id != 'hatbot', created_at, id",
      )
      .all()
      .map(toBot);
  }

  /** A bot, deleted ones too: their tasks and messages still name them. */
  get(id: string): Bot | null {
    const r = this.db.query<Row, [string]>("SELECT * FROM bots WHERE id = ?").get(id);
    return r ? toBot(r) : null;
  }

  /** A bot that isn't deleted. */
  active(id: string): Bot | null {
    const r = this.db
      .query<Row, [string]>("SELECT * FROM bots WHERE id = ? AND deleted_at IS NULL")
      .get(id);
    return r ? toBot(r) : null;
  }

  hatbot(): Bot {
    return this.get(HATBOT_ID) as Bot;
  }

  /** Its name, for notifications and transcripts; the id for one that's gone. */
  nameOf(id: string): string {
    return this.get(id)?.name ?? id;
  }

  /** Who its memory commits are by. */
  author(id: string): Author {
    if (id === HATBOT_ID) return HATBOT;
    return { name: this.nameOf(id), email: `${id}@hatbot.local` };
  }

  create(input: z.infer<typeof CreateBot>): Bot {
    const base = slugOf(input.name);
    let id = base;
    for (let n = 2; this.get(id); n++) id = `${base}-${n}`;
    const taken = this.list().find((b) => b.name.toLowerCase() === input.name.toLowerCase());
    if (taken) throw new BotError(`There's already a bot called ${taken.name}.`);
    this.db
      .query(
        `INSERT INTO bots (id, name, icon, color, instructions, chat_model, chat_effort, plugins, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.name,
        input.icon ?? "hat",
        input.color ?? this.freeColor(),
        input.instructions,
        input.chatModel,
        input.chatEffort,
        input.plugins === null ? null : JSON.stringify(input.plugins),
        new Date(this.clock()).toISOString(),
      );
    return this.changed(id);
  }

  update(id: string, patch: z.infer<typeof UpdateBot>): Bot | null {
    const bot = this.active(id);
    if (!bot) return null;
    if (patch.name !== undefined) {
      const taken = this.list().find(
        (b) => b.id !== id && b.name.toLowerCase() === patch.name?.toLowerCase(),
      );
      if (taken) throw new BotError(`There's already a bot called ${taken.name}.`);
    }
    const next = { ...bot, ...patch };
    this.db
      .query(
        "UPDATE bots SET name = ?, icon = ?, color = ?, instructions = ?, chat_model = ?, chat_effort = ?, plugins = ? WHERE id = ?",
      )
      .run(
        next.name,
        next.icon,
        next.color,
        next.instructions,
        next.chatModel,
        next.chatEffort,
        next.plugins === null ? null : JSON.stringify(next.plugins),
        id,
      );
    return this.changed(id);
  }

  /**
   * Deletes a bot. Its chat, tasks and memory folder stay; its schedules, triggers and watchers go to
   * Hatbot, so they keep running. Hatbot can't be deleted. Null if there's no such bot; otherwise the
   * ids of what moved, so their pages can be told.
   */
  delete(id: string): Moved | null {
    if (id === HATBOT_ID) throw new BotError("Hatbot can't be deleted.");
    if (!this.active(id)) return null;
    const now = new Date(this.clock()).toISOString();
    const move = (table: "schedules" | "triggers" | "watchers") =>
      this.db
        .query<{ id: number }, [string, string]>(
          `UPDATE ${table} SET bot_id = ? WHERE bot_id = ? RETURNING id`,
        )
        .all(HATBOT_ID, id)
        .map((r) => r.id);
    const moved = this.db.transaction(() => {
      this.db.query("UPDATE bots SET deleted_at = ? WHERE id = ?").run(now, id);
      return {
        schedules: move("schedules"),
        triggers: move("triggers"),
        watchers: move("watchers"),
      };
    })();
    this.events.emit({ type: "bot.deleted", id });
    return moved;
  }

  /** The first colour no bot has, so a new one stands apart; once they're all taken, the least used. */
  private freeColor(): Bot["color"] {
    const used = this.list().map((b) => b.color);
    const count = (c: Bot["color"]) => used.filter((u) => u === c).length;
    return BOT_COLORS.reduce((best, c) => (count(c) < count(best) ? c : best));
  }

  private changed(id: string): Bot {
    const bot = this.get(id) as Bot;
    this.events.emit({ type: "bot.updated", bot });
    return bot;
  }
}

/** The bot that runs something of `id`'s: Hatbot instead of one that's been deleted. */
export function liveBot(db: Db, id: string): string {
  if (id === HATBOT_ID) return id;
  const r = db.query("SELECT 1 FROM bots WHERE id = ? AND deleted_at IS NULL").get(id);
  return r ? id : HATBOT_ID;
}

/** Its own memory folder. Hatbot's notes are the shared memory itself, as they always were. */
export const botFolder = (id: string) => (id === HATBOT_ID ? null : `bots/${id}`);

/** A bot's own memory: INDEX.md of its folder. */
export const botIndex = (id: string) => {
  const folder = botFolder(id);
  return folder ? `${folder}/INDEX.md` : null;
};

/**
 * One of the stable prompts as `bot`: its name, its role, its memory and the other bots. Hatbot on its
 * own gets the prompt as it is, so the cache and its conversation carry on.
 */
export function promptFor(base: string, bot: Bot, others: Bot[]): string {
  const named = bot.id === HATBOT_ID ? base : base.replace(/\bHatbot\b/g, bot.name);
  const parts: string[] = [];
  if (bot.instructions.trim())
    parts.push(
      `Your role\n- You are one of the owner's bots, ${bot.name}. The owner describes your role like this:\n<role>\n${bot.instructions.trim()}\n</role>\n- Where your role asks for more care than the rules above, follow it. It doesn't loosen the rules on untrusted content, approvals or payments.`,
    );
  if (others.length) {
    const folder = botFolder(bot.id);
    parts.push(
      [
        "The owner's other bots",
        // Quoted: a role the owner wrote as "You …" is addressed to that bot, not to this one.
        ...others.map(
          (o) =>
            `- ${o.name} (${o.id})${roleLine(o) ? `, whose role begins "${roleLine(o)}"` : ""}`,
        ),
        "- Each bot has its own chat with the owner, and its own plugins and browser profile.",
        "- When the owner asks for work that needs another bot's plugins, logins or notes, hand it over with ask_bot. What you can do with your own tools, quick questions included, do yourself: a hand-off is a background task the owner waits for.",
        folder
          ? `- Memory outside bots/ is shared by every bot: keep what any of them would need there (the owner, their homelab, their projects). Your own notes go in ${folder}/, with ${folder}/INDEX.md mapping them. Leave other bots' folders alone.`
          : "- Memory outside bots/ is shared by every bot, you included. Each other bot keeps its own notes in bots/<its id>/; leave those alone.",
      ].join("\n"),
    );
  }
  return parts.length ? `${named}\n\n${parts.join("\n\n")}` : named;
}

/** A bot's role in a line, for the others' prompts. */
function roleLine(b: Bot): string {
  const line = b.instructions.trim().split("\n")[0]?.trim() ?? "";
  return line.length > 160 ? `${line.slice(0, 159)}…` : line;
}
