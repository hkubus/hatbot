// Your bots (PLAN.md §14): each has its own role, chat, memory folder, plugins and browser profile.
// Hatbot is the first, and can't be deleted.

import type { CreateBot, UpdateBot } from "@hatbot/shared";
import { BOT_COLORS, type Bot, HATBOT_ID } from "@hatbot/shared";
import type { z } from "zod";
import type { Db } from "./db";
import { UserError } from "./errors";
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

export class BotError extends UserError {}

/** What a deleted bot's schedules, triggers and watchers were: they're Hatbot's now, switched off. */
export type Moved = { schedules: number[]; triggers: number[]; watchers: number[] };

/** Letters that don't decompose into a plain one and an accent. */
const FOLDED: Record<string, string> = {
  ł: "l",
  đ: "d",
  ð: "d",
  ø: "o",
  ß: "ss",
  æ: "ae",
  œ: "oe",
  þ: "th",
  ı: "i",
};

/** Lowercase ASCII words joined by hyphens: "Głośny NAS" → "glosny-nas". */
export function slugWords(text: string): string {
  return text
    .toLowerCase()
    .replace(/[łđðøßæœþı]/g, (c) => FOLDED[c] ?? c)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** A bot's id from its name: "Home lab" → "home-lab". */
export function slugOf(name: string): string {
  const slug = slugWords(name).slice(0, 24).replace(/-+$/, "");
  return /^[a-z]/.test(slug) ? slug : `bot-${slug}`.replace(/-+$/, "");
}

/** Plugins that write code. The code bot's are its alone: the others hand that work to it. */
const CODE_PLUGINS = ["code", "claude", "self"];

/**
 * The bot all code and boxes go to (PLAN.md §14.7): the first made, other than Hatbot, whose plugins
 * name the Code plugin, as the Coder template's do. Null without one: then every bot writes its own.
 */
export function codeBotOf(bots: Bot[]): Bot | null {
  return (
    bots
      .filter((b) => b.id !== HATBOT_ID && b.plugins?.includes("code"))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))[0] ?? null
  );
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

  /** The bot code and boxes go to, or null: see codeBotOf. */
  codeBot(): Bot | null {
    return codeBotOf(this.list());
  }

  /** The bot `bot` hands its code and boxes to: the code bot, unless that's `bot` itself. */
  coderFor(bot: Bot): Bot | null {
    const coder = this.codeBot();
    return coder && coder.id !== bot.id ? coder : null;
  }

  /**
   * The plugins `bot` leaves to the other bots, which have them. Hatbot hands the others their work
   * (PLAN.md §14.8), so it gets no plugin another bot names; the rest leave the code bot its code.
   */
  leftToOthers(bot: Bot): string[] {
    if (bot.id === HATBOT_ID)
      return [...new Set(this.list().flatMap((b) => (b.id === bot.id ? [] : (b.plugins ?? []))))];
    const coder = this.coderFor(bot);
    return coder ? CODE_PLUGINS.filter((id) => coder.plugins?.includes(id)) : [];
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
   * Hatbot switched off, since Hatbot may have plugins the bot didn't: you look them over and turn
   * them back on. Hatbot can't be deleted. Null if there's no such bot; otherwise the ids of what
   * moved, so their pages can be told.
   */
  delete(id: string): Moved | null {
    if (id === HATBOT_ID) throw new BotError("Hatbot can't be deleted.");
    if (!this.active(id)) return null;
    const now = new Date(this.clock()).toISOString();
    const move = (table: keyof typeof OFF) =>
      this.db
        .query<{ id: number }, [string, string]>(
          `UPDATE ${table} SET bot_id = ?, ${OFF[table]} WHERE bot_id = ? RETURNING id`,
        )
        .all(HATBOT_ID, id)
        .map((r) => r.id);
    const moved = this.db.transaction(() => {
      this.db.query("UPDATE bots SET deleted_at = ? WHERE id = ?").run(now, id);
      // What you always allowed it was for it, with its plugins.
      this.db.query("DELETE FROM approval_rules WHERE bot_id = ?").run(id);
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

/** Switched off, as a deleted bot's automations go to Hatbot. Turning one back on works out when it's next due. */
const OFF = {
  schedules: "enabled = 0, next_run_at = NULL",
  triggers: "enabled = 0",
  watchers: "enabled = 0, next_check_at = NULL",
};

/**
 * Whether an automation is a deleted bot's: one delete didn't move, made by the bot's reply as it was
 * deleted. It goes to Hatbot switched off as the others did, and doesn't run: Hatbot may have plugins
 * the bot didn't.
 */
export function orphaned(db: Db, table: keyof typeof OFF, id: number, botId: string): boolean {
  if (botId === HATBOT_ID) return false;
  if (db.query("SELECT 1 FROM bots WHERE id = ? AND deleted_at IS NULL").get(botId)) return false;
  db.query(`UPDATE ${table} SET bot_id = ?, ${OFF[table]} WHERE id = ?`).run(HATBOT_ID, id);
  console.log(`${table} ${id}: its bot ${botId} was deleted; moved to Hatbot, switched off`);
  return true;
}

/** Its own memory folder. Hatbot's notes are the shared memory itself, as they always were. */
export const botFolder = (id: string) => (id === HATBOT_ID ? null : `bots/${id}`);

/** A bot's own memory: INDEX.md of its folder. */
export const botIndex = (id: string) => {
  const folder = botFolder(id);
  return folder ? `${folder}/INDEX.md` : null;
};

/** What a bot other than Hatbot is told about handing work to the others. */
const HAND_OVER =
  "When the owner asks for work that needs another bot's plugins, logins or notes, hand it over with ask_bot. What you can do with your own tools, quick questions included, do yourself: the other bot answers in its own chat, and the owner waits for it.";

/** Hatbot with other bots, in the chat and in tasks: it hands them their work (PLAN.md §14.8). */
const ROUTE =
  "Hand each piece of the owner's work to the bot whose role or plugins it falls under, with ask_bot, and pass on what came of it. That goes for work you have tools for too, like research when a bot's role is research. The plugins another bot has are its alone. Do yourself only what no other bot's role covers, like memory, the to-do list and quick lookups.";

/** And in its chat. */
const ROUTE_CHAT = [
  "You're the bot the owner talks to first, and the others can't see this chat: give a bot the owner's words and everything that bears on them. When it answers that it needs something only the owner can say, ask them with ask_owner, then hand it their answer; a follow-up on its work goes back to it too.",
  "A schedule or watcher for another bot's work is that bot's to make: ask it, so the runs have its tools.",
];

/** "A, B and C". */
const listed = new Intl.ListFormat("en-GB", { type: "conjunction" });

/**
 * One of the stable prompts as `bot`: its name, its role, its memory and the other bots, each with
 * the plugins it has (`plugins`, their names). Hatbot on its own gets the prompt as it is, so the cache
 * and its conversation carry on. `chat`: for its chat rather than a task. `handOver`: what it's told
 * about asking the others, in place of the usual.
 */
export function promptFor(
  base: string,
  bot: Bot,
  others: Bot[],
  {
    plugins = () => [],
    chat = false,
    handOver,
  }: { plugins?: (b: Bot) => string[]; chat?: boolean; handOver?: string } = {},
): string {
  const named = bot.id === HATBOT_ID ? base : base.replace(/\bHatbot\b/g, bot.name);
  const parts: string[] = [];
  if (bot.instructions.trim())
    parts.push(
      `Your role\n- You are one of the owner's bots, ${bot.name}. The owner describes your role like this:\n<role>\n${bot.instructions.trim()}\n</role>\n- Where your role asks for more care than the rules above, follow it. It doesn't loosen the rules on untrusted content, approvals or payments.`,
    );
  if (others.length) {
    const folder = botFolder(bot.id);
    const route = bot.id === HATBOT_ID ? [ROUTE, ...(chat ? ROUTE_CHAT : [])] : [HAND_OVER];
    parts.push(
      [
        "The owner's other bots",
        ...others.map((o) => rosterLine(o, plugins(o))),
        "- Each bot has its own chat with the owner, and its own plugins and browser profile.",
        ...(handOver ? [handOver] : route).map((line) => `- ${line}`),
        ...codeLine(bot, others),
        folder
          ? `- Memory outside bots/ is shared by every bot: keep what any of them would need there (the owner, their homelab, their projects). Your own notes go in ${folder}/, with ${folder}/INDEX.md mapping them. Leave other bots' folders alone.`
          : "- Memory outside bots/ is shared by every bot, you included. Each other bot keeps its own notes in bots/<its id>/; leave those alone.",
      ].join("\n"),
    );
  }
  return parts.length ? `${named}\n\n${parts.join("\n\n")}` : named;
}

/** Who writes code and makes boxes, when one bot does it for all of them. */
function codeLine(bot: Bot, others: Bot[]): string[] {
  const coder = codeBotOf([bot, ...others]);
  if (!coder) return [];
  return coder.id === bot.id
    ? [
        "- The other bots hand you their code and boxes. You can change any of the owner's boxes, whoever made it.",
      ]
    : [
        `- Code is ${coder.name}'s: writing or changing code, scripts and boxes. Hand it to ${coder.name} with ask_bot, with everything it needs, rather than writing it yourself.`,
      ];
}

/**
 * Another bot in a bot's prompt, with its plugins and its role in a line. Quoted: a role the owner
 * wrote as "You …" is addressed to that bot, not to this one.
 */
function rosterLine(o: Bot, plugins: string[]): string {
  const role = roleLine(o);
  return `- ${o.name} (${o.id})${plugins.length ? `, with ${listed.format(plugins)}` : ""}${
    role ? `, whose role begins "${role}"` : ""
  }${o.id === HATBOT_ID ? ": the owner talks to it first, and it hands the rest of you their work" : ""}`;
}

/** A bot as lists show it, with only its role's first line: a role can be 8,000 characters. */
export const briefBot = (b: Bot): Bot => ({ ...b, instructions: roleLine(b), brief: true });

/** A bot's role in a line, for the others' prompts. */
function roleLine(b: Bot): string {
  const line = b.instructions.trim().split("\n")[0]?.trim() ?? "";
  return line.length > 160 ? `${line.slice(0, 159)}…` : line;
}
