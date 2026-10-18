// Boxes (PLAN.md §21): small web apps a bot makes for you, every version kept, and what their pages
// save. The brain never runs a box's code: it serves the page sandboxed, on an opaque origin with no
// network, and keeps what the page saves through the app, which answers only that box's frame.
import { createHash, createHmac } from "node:crypto";
import {
  API_PREFIX,
  type Box,
  type BoxAnswer,
  type BoxCall,
  type BoxDetail,
  type BoxPage,
  type BoxSecret,
  type BoxVersion,
  HATBOT_ID,
  MAX_BOX_STORE,
  MAX_BOX_VALUE,
} from "@hatbot/shared";
import { LOOK_BINDING } from "@hatbot/shared/desktop";
import {
  BOX_CONFIG,
  BOX_SERVER,
  type BoxConfig,
  type BoxFile,
  type BoxSecrets,
  boxConfig,
  MAX_BOX_NOTIFY,
} from "@hatbot/shared/hatbox";
import type { Chats } from "./agent/chats";
import { type CreateParams, type ModelClient, modelErrorText, oneShot } from "./agent/model";
import { sameText, secretKey } from "./auth/keys";
import type { BoxActions } from "./box-actions";
import type { BoxFeeds } from "./box-feeds";
import type { Db } from "./db";
import { UserError } from "./errors";
import type { EventBus } from "./events";
import type { Backends } from "./hatbox/backends";
import type { Notifier } from "./notify";
import type { Secrets } from "./secrets";
import type { SettingsStore } from "./settings";
import { BudgetError, estimateTokens, fixedTokens, requestCeiling, type Spend } from "./spend";

/** Why a box can't be made, changed or kept: the message is for the model, or for you. */
export class BoxError extends UserError {}

type Row = {
  id: number;
  bot_id: string;
  conversation_id: number | null;
  title: string;
  version: number;
  created_at: string;
  updated_at: string;
};

const toBox = (r: Row): Box => ({
  id: r.id,
  botId: r.bot_id,
  conversationId: r.conversation_id,
  title: r.title,
  version: r.version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const VERSION_COLUMNS = "n, title, created_at AS createdAt, message_id AS messageId";

/** Where a version came from: the reply that made it, and what the conversation had read. */
export type Made = { messageId?: number | null; taintedBy?: string | null };

/** Files in one order, to tell whether they changed. */
const sorted = (files: BoxFile[] | undefined) =>
  files?.length ? [...files].sort((a, b) => (a.path < b.path ? -1 : 1)) : undefined;

/** How long an address to open a box's page holds. */
const OPEN_MS = 10 * 60_000;

/** hatbox.ask's model, and what it may write when the page doesn't say, thinking included. */
export const BOX_ASK_MODEL = "claude-haiku-5-5";
const ASK_TOKENS = 4000;
/** Notes a box's page may put in the chat in an hour (hatbox.send). */
const NOTES_PER_HOUR = 5;
/**
 * Notifications a box's backend may send in a day (scheduled() returning {notify}). Fewer than notes:
 * each one buzzes your phone, and a schedule runs up to 288 times a day.
 */
export const NOTIFY_PER_DAY = 10;

/**
 * What hatbox.ask, .send, .feed and .action, and backends' notifications, need: given once the chats
 * exist.
 */
export type BoxDeps = {
  settings: SettingsStore;
  spend: Spend;
  /** The background model, for hatbox.ask. */
  model: ModelClient;
  chats: Chats;
  feeds: BoxFeeds;
  actions: BoxActions;
  notifier: Notifier;
  publicUrl: string;
};

export class Boxes {
  private key: Buffer;
  private d: BoxDeps | null = null;
  /** What hatbox.ask's answers on their way may still cost, held against the boxes' daily limit. */
  private asking = 0;
  /** Server boxes' backends, on the boxes guest (PLAN.md §21.6). */
  backends?: Backends;

  constructor(
    private db: Db,
    private events: EventBus,
    private clock: () => number = Date.now,
    /** Where boxes' secrets are kept: with the brain's other secrets, out of the database. */
    private vault?: Secrets,
  ) {
    this.key = secretKey(db, "box_key");
  }

  private now() {
    return new Date(this.clock()).toISOString();
  }

  /** Called once the chats exist: hatbox.ask, .send and .feed need them. */
  connect(d: BoxDeps) {
    this.d = d;
  }

  get feeds(): BoxFeeds | null {
    return this.d?.feeds ?? null;
  }

  get actions(): BoxActions | null {
    return this.d?.actions ?? null;
  }

  /** The latest changed first; only `botId`'s, when it's given. */
  list(botId?: string): Box[] {
    const where = botId === undefined ? "" : "WHERE bot_id = ?";
    return this.db
      .query<Row, string[]>(`SELECT * FROM boxes ${where} ORDER BY updated_at DESC, id DESC`)
      .all(...(botId === undefined ? [] : [botId]))
      .map(toBox);
  }

  get(id: number): Box | null {
    const r = this.db.query<Row, [number]>("SELECT * FROM boxes WHERE id = ?").get(id);
    return r ? toBox(r) : null;
  }

  detail(id: number): BoxDetail | null {
    const box = this.get(id);
    if (!box) return null;
    const versions = this.db
      .query<BoxVersion, [number]>(
        `SELECT ${VERSION_COLUMNS} FROM box_versions WHERE box_id = ? ORDER BY n`,
      )
      .all(id);
    return { ...box, versions, secrets: this.secrets(id), actions: this.d?.actions.info(id) ?? [] };
  }

  /** A version's page, the current one unless `n` is given. */
  page(id: number, n?: number): BoxPage | null {
    const v =
      n ??
      this.db.query<{ version: number }, [number]>("SELECT version FROM boxes WHERE id = ?").get(id)
        ?.version;
    if (v === undefined) return null;
    const page = this.db
      .query<BoxPage, [number, number]>(
        `SELECT ${VERSION_COLUMNS}, html FROM box_versions WHERE box_id = ? AND n = ?`,
      )
      .get(id, v);
    const files = page && this.files(id, v);
    return page && (files?.length ? { ...page, files } : page);
  }

  /** A version's files, the current one's unless `n` is given; none for a box of one page. */
  files(id: number, n?: number): BoxFile[] {
    return this.db
      .query<BoxFile, [number, number | null, number]>(
        `SELECT path, content FROM box_files
         WHERE box_id = ? AND n = COALESCE(?, (SELECT version FROM boxes WHERE id = ?)) ORDER BY path`,
      )
      .all(id, n ?? null, id);
  }

  /** What the current version's box.json says. */
  config(id: number): BoxConfig {
    try {
      return boxConfig(this.files(id).find((f) => f.path === BOX_CONFIG)?.content);
    } catch {
      return { hosts: [], packages: {}, secrets: [] };
    }
  }

  /** The hosts the box's backend may reach, from its box.json. */
  hosts(id: number): string[] {
    return this.config(id).hosts;
  }

  /** The secrets the current version's box.json declares, and whether you've set each; no values. */
  secrets(id: number): BoxSecret[] {
    const set = this.vault?.box(id) ?? {};
    return this.config(id).secrets.map((name) => ({ name, set: name in set }));
  }

  /**
   * The secrets of the box you've set, whether its box.json declares them now or not: a later version
   * could declare one again.
   */
  setSecretNames(id: number): string[] {
    return Object.keys(this.vault?.box(id) ?? {});
  }

  hasSecrets(id: number): boolean {
    return this.setSecretNames(id).length > 0;
  }

  /**
   * What the backend starts with: the secrets its box.json declares that you've set, and a name for
   * that set of them, which tells the guest whether it has them.
   */
  secretValues(id: number): BoxSecrets {
    const set = this.vault?.box(id) ?? {};
    const values = Object.fromEntries(
      this.config(id).secrets.flatMap((n) => (set[n] === undefined ? [] : [[n, set[n]]])),
    );
    const digest = Object.keys(values).length
      ? createHash("sha256").update(JSON.stringify(values)).digest("hex").slice(0, 32)
      : "";
    return { values, digest };
  }

  /** You set or (null) remove some of the box's secrets. Only names its box.json declares are set. */
  async setSecrets(id: number, changes: Record<string, string | null>): Promise<BoxSecret[]> {
    if (!this.vault) throw new BoxError("Boxes can't have secrets here.", 503);
    const declared = this.config(id).secrets;
    const unknown = Object.keys(changes).find((n) => changes[n] !== null && !declared.includes(n));
    if (unknown) throw new BoxError(`${unknown} isn't one of this box's secrets.`);
    this.vault.setBox(id, changes);
    await this.backends?.sendSecrets(id);
    return this.secrets(id);
  }

  /**
   * `text` from the box's guest with every value of its secrets taken out, also as a URL or JSON
   * would spell it: for what the model, the page or a log sees.
   */
  redact(id: number, text: string): string {
    for (const [name, value] of Object.entries(this.vault?.box(id) ?? {}))
      for (const form of new Set([
        value,
        encodeURIComponent(value),
        JSON.stringify(value).slice(1, -1),
      ]))
        text = text.replaceAll(form, `[secret ${name}]`);
    return text;
  }

  /** Whether the current version has a backend. */
  server(id: number): boolean {
    return this.files(id).some((f) => f.path === BOX_SERVER);
  }

  /** Boxes whose backend has a schedule, and when it last ran (or since when it's had none). */
  scheduled(): { id: number; cron: string; since: string; ranAt: string | null }[] {
    return this.db
      .query<{ id: number; since: string; ranAt: string | null }, []>(
        `SELECT b.id, COALESCE(b.ran_at, b.updated_at) AS since, b.ran_at AS ranAt FROM boxes b
         JOIN box_files f ON f.box_id = b.id AND f.n = b.version AND f.path = '${BOX_SERVER}'`,
      )
      .all()
      .flatMap((b) => {
        const { cron } = this.config(b.id);
        return cron ? [{ ...b, cron }] : [];
      });
  }

  /** The box's schedule ran at `at`. */
  ran(id: number, at: string) {
    this.db.query("UPDATE boxes SET ran_at = ? WHERE id = ?").run(at, id);
  }

  /** A number for a new box, which nothing has had: one with files is built under it first. */
  reserve(): number {
    return this.db
      .query<{ id: number }, []>("INSERT INTO box_ids DEFAULT VALUES RETURNING id")
      .get()?.id as number;
  }

  /** The number the box's next version gets. */
  nextVersion(id: number): number {
    return (
      (this.db
        .query<{ n: number | null }, [number]>(
          "SELECT MAX(n) AS n FROM box_versions WHERE box_id = ?",
        )
        .get(id)?.n ?? 0) + 1
    );
  }

  /**
   * What the first version tainted work wrote had read, or null. Its page may carry what that work
   * read into every later version, so the whole box reads back as untrusted (PLAN.md §21.1).
   */
  taintedBy(id: number): string | null {
    return (
      this.db
        .query<{ by: string }, [number]>(
          "SELECT tainted_by AS by FROM box_versions WHERE box_id = ? AND tainted_by IS NOT NULL ORDER BY n LIMIT 1",
        )
        .get(id)?.by ?? null
    );
  }

  create(
    b: {
      botId: string;
      conversationId: number | null;
      title: string;
      html: string;
      /** A box with files: the number it was built under, and the files. */
      id?: number;
      files?: BoxFile[];
    },
    made: Made,
  ): Box {
    const now = this.now();
    const id = this.db.transaction(() => {
      const row = this.db
        .query<{ id: number }, [number, string, number | null, string, string, string]>(
          `INSERT INTO boxes (id, bot_id, conversation_id, title, version, created_at, updated_at)
           VALUES (?, ?, ?, ?, 1, ?, ?) RETURNING id`,
        )
        .get(b.id ?? this.reserve(), b.botId, b.conversationId, b.title, now, now);
      const id = row?.id ?? -1;
      this.addVersion(id, 1, b.title, b.html, made, now, b.files);
      return id;
    })();
    return this.changed(id);
  }

  /**
   * A new version with this title and page (and files, for a box with them), which opens from now on;
   * null when nothing changed.
   */
  save(id: number, title: string, html: string, made: Made, files?: BoxFile[]): Box | null {
    const current = this.page(id);
    if (!current) throw new BoxError(`There's no box #${id}.`);
    const sameFiles = JSON.stringify(sorted(current.files)) === JSON.stringify(sorted(files));
    if (current.title === title && current.html === html && sameFiles) return null;
    const now = this.now();
    this.db.transaction(() => {
      const last = this.db
        .query<{ n: number }, [number]>("SELECT MAX(n) AS n FROM box_versions WHERE box_id = ?")
        .get(id);
      const n = (last?.n ?? 0) + 1;
      this.addVersion(id, n, title, html, made, now, files);
      this.db
        .query("UPDATE boxes SET title = ?, version = ?, updated_at = ? WHERE id = ?")
        .run(title, n, now, id);
    })();
    return this.changed(id);
  }

  /** A new version with an earlier one's title and page. */
  revert(id: number, n: number, made: Made): Box | null {
    const old = this.page(id, n);
    if (!old) throw new BoxError(`Box #${id} has no version ${n}.`);
    return this.save(id, old.title, old.html, made, old.files);
  }

  private addVersion(
    id: number,
    n: number,
    title: string,
    html: string,
    made: Made,
    now: string,
    files: BoxFile[] = [],
  ) {
    this.db
      .query(
        `INSERT INTO box_versions (box_id, n, title, html, message_id, tainted_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, n, title, html, made.messageId ?? null, made.taintedBy ?? null, now);
    const file = this.db.query(
      "INSERT INTO box_files (box_id, n, path, content) VALUES (?, ?, ?, ?)",
    );
    for (const f of files) file.run(id, n, f.path, f.content);
  }

  /** Every version and what its page saved go with it. */
  delete(id: number): boolean {
    const gone = this.db.transaction(() => {
      this.db.query("UPDATE messages SET box_id = NULL WHERE box_id = ?").run(id);
      return this.db.query("DELETE FROM boxes WHERE id = ?").run(id).changes > 0;
    })();
    if (gone) {
      this.events.emit({ type: "box.deleted", id });
      void this.backends?.remove(id);
      this.d?.actions.forget(id);
      const names = this.setSecretNames(id);
      if (names.length) this.vault?.setBox(id, Object.fromEntries(names.map((n) => [n, null])));
    }
    return gone;
  }

  /** Shows the box under the reply that made or changed it; the last one it touched, if several. */
  attach(messageId: number, boxId: number) {
    this.db.query("UPDATE messages SET box_id = ? WHERE id = ?").run(boxId, messageId);
    this.events.emit({ type: "message.box", id: messageId, boxId });
  }

  /** A deleted bot's boxes go to Hatbot (PLAN.md §21.1). */
  orphan(botId: string) {
    const ids = this.db
      .query<{ id: number }, [string, string]>(
        "UPDATE boxes SET bot_id = ? WHERE bot_id = ? RETURNING id",
      )
      .all(HATBOT_ID, botId);
    for (const { id } of ids) this.changed(id);
  }

  private changed(id: number): Box {
    const box = this.get(id) as Box;
    this.events.emit({ type: "box.updated", box });
    return box;
  }

  /** A call from the box's page through the app (PLAN.md §21.2). */
  async call(id: number, c: BoxCall): Promise<BoxAnswer> {
    switch (c.op) {
      case "fetch":
        if (!this.backends) throw new BoxError("This box has no backend.");
        return this.backends.fetch(id, c);
      case "get": {
        const r = this.db
          .query<{ value: string }, [number, string]>(
            "SELECT value FROM box_store WHERE box_id = ? AND key = ?",
          )
          .get(id, c.key);
        return r ? { value: JSON.parse(r.value) } : {};
      }
      case "keys":
        return {
          value: this.db
            .query<{ key: string }, [number]>(
              "SELECT key FROM box_store WHERE box_id = ? ORDER BY key",
            )
            .all(id)
            .map((r) => r.key),
        };
      case "delete":
        this.db.query("DELETE FROM box_store WHERE box_id = ? AND key = ?").run(id, c.key);
        return {};
      case "set": {
        const json = JSON.stringify(c.value);
        if (json === undefined) throw new BoxError("That isn't a value a box can keep.");
        const size = Buffer.byteLength(json) + Buffer.byteLength(c.key);
        if (size > MAX_BOX_VALUE) throw new BoxError("A box keeps at most 1 MB under one key.");
        const rest = this.db
          .query<{ size: number | null }, [number, string]>(
            "SELECT SUM(length(CAST(value AS BLOB)) + length(CAST(key AS BLOB))) AS size FROM box_store WHERE box_id = ? AND key != ?",
          )
          .get(id, c.key);
        if ((rest?.size ?? 0) + size > MAX_BOX_STORE)
          throw new BoxError("The box is full: it keeps at most 5 MB.");
        this.db
          .query(
            `INSERT INTO box_store (box_id, key, value, updated_at) VALUES (?, ?, ?, ?)
             ON CONFLICT (box_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
          )
          .run(id, c.key, json, this.now());
        return {};
      }
      case "ask":
        return { value: await this.ask(this.existing(id), c) };
      case "send":
        this.send(this.existing(id), c.text);
        return {};
      case "feed": {
        const { feeds } = this.connected();
        const latest = c.fresh ? await feeds.fresh(id, c.name) : feeds.latest(id, c.name);
        return latest ? { value: latest } : {};
      }
      case "action": {
        const { actions } = this.connected();
        if (!c.check) return { value: await actions.press(this.existing(id).id, c.name) };
        const last = actions.last(id, c.name);
        return last ? { value: last } : {};
      }
    }
  }

  private existing(id: number): Box {
    const box = this.get(id);
    if (!box) throw new BoxError("That box is gone.", 404);
    return box;
  }

  private connected(): BoxDeps {
    if (!this.d) throw new BoxError("Boxes can't do that here.", 503);
    return this.d;
  }

  /**
   * Haiku's answer to the page, with no tools (hatbox.ask). The chat's model never sees it. Boxes have
   * a daily limit of their own, besides the brain's, and nothing is asked while Hatbot is paused.
   */
  private async ask(box: Box, c: Extract<BoxCall, { op: "ask" }>): Promise<string> {
    const d = this.connected();
    const { paused, limits } = d.settings.get();
    if (paused) throw new BoxError("Hatbot is paused.", 409);
    const params: CreateParams = {
      model: BOX_ASK_MODEL,
      max_tokens: c.maxTokens ?? ASK_TOKENS,
      thinking: { type: "adaptive" },
      output_config: { effort: "low" },
      ...(c.system ? { system: c.system } : {}),
      messages: [{ role: "user", content: c.prompt }],
    };
    const most = requestCeiling(BOX_ASK_MODEL, {
      prompt: fixedTokens(params.system, null) + estimateTokens(params.messages),
      maxTokens: params.max_tokens,
    });
    const spent = d.spend.byPurpose(1).find((p) => p.purpose === "boxes")?.costUsd ?? 0;
    if (spent + this.asking + most > limits.boxesUsd)
      throw new BoxError(
        `Boxes have used today's $${limits.boxesUsd} for asking Haiku. It's in Settings, under Spending limits.`,
        429,
      );
    this.asking += most;
    try {
      return await oneShot(d, params, { purpose: "boxes", botId: box.botId });
    } catch (err) {
      if (err instanceof BudgetError) throw new BoxError(err.message, 429);
      console.error(`box ${box.id}: ask failed`, err);
      throw new BoxError(`Haiku didn't answer: ${modelErrorText(err)}`, 502);
    } finally {
      this.asking -= most;
    }
  }

  /** A note from the page in the box's chat (hatbox.send), a few an hour. */
  private send(box: Box, text: string) {
    const since = new Date(this.clock() - 3600_000).toISOString();
    const sent =
      this.db
        .query<{ n: number }, [number, string]>(
          `SELECT count(*) AS n FROM messages WHERE box_id = ?1 AND kind = 'box' AND created_at > ?2
           AND id NOT IN (SELECT message_id FROM box_notices
             WHERE box_id = ?1 AND message_id IS NOT NULL)
           AND id NOT IN (SELECT message_id FROM box_action_runs
             WHERE box_id = ?1 AND message_id IS NOT NULL)`,
        )
        .get(box.id, since)?.n ?? 0;
    if (sent >= NOTES_PER_HOUR)
      throw new BoxError(`A box sends at most ${NOTES_PER_HOUR} notes an hour.`, 429);
    this.connected().chats.boxNote(box, text);
  }

  /**
   * What the box's backend asked to tell you (scheduled() returning {notify}): a notification that
   * opens the box, and a note in its chat, so it's kept and the bot reads it, as untrusted, with your
   * next message. Why it wasn't sent, or null.
   */
  notify(id: number, text: string): string | null {
    const box = this.get(id);
    if (!box || !this.d) return "Boxes can't notify here.";
    const since = new Date(this.clock() - 86400_000).toISOString();
    const sent =
      this.db
        .query<{ n: number }, [number, string]>(
          "SELECT count(*) AS n FROM box_notices WHERE box_id = ? AND created_at > ?",
        )
        .get(id, since)?.n ?? 0;
    if (sent >= NOTIFY_PER_DAY) return `a box notifies at most ${NOTIFY_PER_DAY} times a day.`;
    const message = text.length > MAX_BOX_NOTIFY ? `${text.slice(0, MAX_BOX_NOTIFY - 1)}…` : text;
    const note = this.d.chats.boxNote(box, message);
    this.db
      .query("INSERT INTO box_notices (box_id, message_id, created_at) VALUES (?, ?, ?)")
      .run(id, note.id, this.now());
    void this.d.notifier.send({
      title: box.title,
      message,
      priority: 3,
      click: `${this.d.publicUrl}/boxes/${id}`,
    });
    return null;
  }

  /** Everything the box's page saved, by key. */
  data(id: number): Record<string, unknown> {
    const rows = this.db
      .query<{ key: string; value: string }, [number]>(
        "SELECT key, value FROM box_store WHERE box_id = ? ORDER BY key",
      )
      .all(id);
    return Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value)]));
  }

  private sign(id: number, n: number, exp: number): string {
    return createHmac("sha256", this.key).update(`${id}:${n}:${exp}`).digest("base64url");
  }

  /**
   * Where the app opens a version's page, for a while: the signature stands in for the session, which
   * the page's opaque origin doesn't send, and which the iOS app doesn't have.
   */
  address(id: number, n: number, dark: boolean): string {
    const exp = Math.floor((this.clock() + OPEN_MS) / 1000);
    const q = new URLSearchParams({ v: String(n), exp: String(exp), sig: this.sign(id, n, exp) });
    if (dark) q.set("dark", "1");
    return `${API_PREFIX}/boxes/${id}/frame?${q}`;
  }

  /** The page with Hatbox at its top, while the address holds; null once it doesn't. */
  frame(id: number, n: number, exp: number, sig: string, dark: boolean): string | null {
    if (exp * 1000 < this.clock() || !sameText(sig, this.sign(id, n, exp))) return null;
    const page = this.page(id, n);
    return page && framed(page.html, dark);
  }
}

/** A box's page's Content-Security-Policy (PLAN.md §21.1), in the app and in box_look's render. */
export const FRAME_CSP =
  "sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'";

/**
 * The app's colours, following light and dark (apps/web/src/styles.css), and its type, as defaults a
 * box's own styles override. Its fonts can't load here: the page reaches nothing outside itself.
 */
const BASE_CSS = `:root{--hb-bg:light-dark(#f5f5f7,#161617);--hb-surface:light-dark(#fff,#1e1e20);--hb-text:light-dark(#1d1d1f,#f5f5f7);--hb-muted:light-dark(#6e6e73,#98989d);--hb-line:light-dark(rgba(0,0,0,.09),rgba(255,255,255,.09));--hb-accent:light-dark(#e8820c,#ff9f2e);--hb-on-accent:#1d1d1f;--hb-attention:light-dark(#007aff,#0a84ff);--hb-danger:light-dark(#ff3b30,#ff453a);--hb-success:light-dark(#34c759,#30d158);--hb-font:system-ui,-apple-system,"Segoe UI",sans-serif;--hb-mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace}:where(:root){background:var(--hb-bg);color:var(--hb-text);font-family:var(--hb-font)}`;

/**
 * window.hatbox (PLAN.md §21.2). Each call goes to the app, which passes it on to the brain for this
 * box only (POST /boxes/:id/call), so a new kind of call needs nothing new in the apps. In the web app
 * the page is a frame and calls are messages to its parent, which also sends the theme; in the iOS app
 * it's the web view's own page, and calls go to WebKit's `hatbox` handler, which replies. Links to
 * other pages open in a new tab, since the frame can't leave the box. In box_look's render there's no
 * app: the store is kept in memory for that render, and calls that would reach outside the page fail,
 * but for fetch in a look with the backend, which goes to the renderer's binding and so to the brain.
 */
const HATBOX = `(() => {
  const root = document.documentElement;
  const theme = { dark: __DARK__ };
  const preview = __PREVIEW__;
  const scheme = () => { root.style.colorScheme = theme.dark ? "dark" : "light"; };
  scheme();
  const setDark = (dark) => {
    theme.dark = Boolean(dark);
    scheme();
    dispatchEvent(new Event("hatboxtheme"));
  };
  const native = parent === window ? window.webkit?.messageHandlers?.hatbox : undefined;
  let next = 1;
  const waiting = new Map();
  const kept = new Map(Object.entries(preview || {}).map(([k, v]) => [k, JSON.stringify(v)]));
  const bind = __RELAY__ && window.__LOOK_BINDING__;
  const sent = new Map();
  if (bind)
    Object.defineProperty(window, "__hatboxAnswer", {
      value: (id, a) => {
        const w = sent.get(id);
        if (!w) return;
        sent.delete(id);
        if (typeof a?.error === "string") w.reject(new Error(a.error));
        else w.resolve(a?.value);
      },
    });
  const previewCall = async (op, args) => {
    if (op === "get") return kept.has(args.key) ? JSON.parse(kept.get(args.key)) : undefined;
    if (op === "keys") return [...kept.keys()].sort();
    if (op === "delete") return void kept.delete(args.key);
    if (op === "fetch" && bind)
      return new Promise((resolve, reject) => {
        const id = next++;
        sent.set(id, { resolve, reject });
        bind(JSON.stringify({ ...args, id }));
      });
    if (op !== "set") throw new Error("Not in a preview.");
    const json = JSON.stringify(args.value);
    if (json === undefined) throw new Error("That isn't a value a box can keep.");
    kept.set(args.key, json);
  };
  const call = (op, args) => {
    if (preview) return previewCall(op, args);
    if (native)
      return native.postMessage({ ...args, op }).catch((e) => {
        throw new Error(typeof e === "string" ? e : e?.message || "Couldn't reach Hatbot.");
      });
    return new Promise((resolve, reject) => {
      if (parent === window) return reject(new Error("Open this box in Hatbot."));
      const id = next++;
      waiting.set(id, { resolve, reject });
      parent.postMessage({ ...args, op, hatbox: id }, "*");
    });
  };
  if (native) Object.defineProperty(window, "__hatboxTheme", { value: setDark });
  addEventListener("message", (e) => {
    const d = e.data;
    if (e.source !== parent || parent === window || !d || typeof d.hatbox !== "number") return;
    if (d.hatbox === 0) return setDark(d.dark);
    const w = waiting.get(d.hatbox);
    if (!w) return;
    waiting.delete(d.hatbox);
    if (typeof d.error === "string") w.reject(new Error(d.error));
    else w.resolve(d.value);
  });
  addEventListener("click", (e) => {
    const a = e.target instanceof Element && e.target.closest("a[href]");
    if (!a || (a.target && !/^_(self|parent|top)$/i.test(a.target)) || (a.getAttribute("href") || "").startsWith("#") || !/^https?:/i.test(a.href)) return;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
  }, true);
  // hatbox.fetch: the box's backend, as JSON through the app. A body that isn't UTF-8 text goes as base64.
  const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const encoded = (bytes) => {
    if (!bytes.length) return {};
    try {
      return { body: utf8.decode(bytes) };
    } catch {
      let s = "";
      for (let i = 0; i < bytes.length; i += 32768) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 32768));
      return { body: btoa(s), base64: true };
    }
  };
  const boxFetch = async (path, init) => {
    path = String(path);
    const req = new Request("https://box.invalid" + (path.startsWith("/") ? "" : "/") + path, init);
    const url = new URL(req.url);
    const headers = {};
    req.headers.forEach((v, k) => { headers[k] = v; });
    const bytes = new Uint8Array(await req.arrayBuffer());
    const r = await call("fetch", { path: url.pathname + url.search, method: req.method, headers, ...encoded(bytes) });
    const body = r.base64 ? Uint8Array.from(atob(r.body), (c) => c.charCodeAt(0)) : r.body;
    return new Response([204, 205, 304].includes(r.status) ? null : body, { status: r.status, headers: r.headers });
  };
  window.hatbox = Object.freeze({
    store: Object.freeze({
      get: (key) => call("get", { key: String(key) }),
      set: (key, value) => call("set", { key: String(key), value }),
      delete: (key) => call("delete", { key: String(key) }),
      keys: () => call("keys", {}),
    }),
    ask: (prompt, o) => {
      const { system, maxTokens } = o || {};
      const args = { prompt: String(prompt) };
      if (system !== undefined) args.system = String(system);
      if (maxTokens !== undefined) args.maxTokens = Number(maxTokens);
      return call("ask", args);
    },
    send: (text) => call("send", { text: String(text) }),
    feed: (name, o) => call("feed", o?.fresh ? { name: String(name), fresh: true } : { name: String(name) }),
    action: (name, o) => call("action", { name: String(name), ...(o && o.check ? { check: true } : {}) }),
    fetch: boxFetch,
    theme,
  });
})();`;

/** A box's page with Hatbox's styles and script first: after a doctype, so it keeps standards mode. */
export function framed(html: string, dark: boolean): string {
  return withHatbox(html, dark, null).html;
}

/**
 * A box's page as box_look draws it (PLAN.md §21.12): hatbox.store starts with `store` and keeps what
 * the page saves in memory, for that render only. With `backend`, hatbox.fetch goes out through the
 * renderer's binding (§21.15). `lines`: how many lines Hatbox puts above the page's own, which the
 * line numbers of its errors count.
 */
export function previewed(
  html: string,
  dark: boolean,
  store: Record<string, unknown>,
  backend = false,
): { html: string; lines: number } {
  return withHatbox(html, dark, store, backend);
}

function withHatbox(
  html: string,
  dark: boolean,
  preview: Record<string, unknown> | null,
  backend = false,
) {
  // As JSON in the script, with no "<" that could end it. A function, so "$&" in it stays as it is.
  // Last, so nothing in it is taken for a placeholder.
  const json = preview ? JSON.stringify(preview).replace(/</g, "\\u003c") : "null";
  const script = HATBOX.replace("__DARK__", String(dark))
    .replace("__RELAY__", String(backend))
    .replace("__LOOK_BINDING__", LOOK_BINDING)
    .replace("__PREVIEW__", () => json);
  const head = `<style>${BASE_CSS}</style><script>${script}</script>`;
  const at = /^\s*<!doctype[^>]*>/i.exec(html)?.[0].length ?? 0;
  return { html: html.slice(0, at) + head + html.slice(at), lines: head.split("\n").length - 1 };
}
