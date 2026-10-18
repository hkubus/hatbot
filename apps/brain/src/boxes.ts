// Boxes (PLAN.md §21): small web apps a bot makes for you, every version kept, and what their pages
// save. The brain never runs a box's code: it serves the page sandboxed, on an opaque origin with no
// network, and keeps what the page saves through the app, which answers only that box's frame.
import { createHmac } from "node:crypto";
import {
  API_PREFIX,
  type Box,
  type BoxAnswer,
  type BoxCall,
  type BoxDetail,
  type BoxPage,
  type BoxVersion,
  HATBOT_ID,
  MAX_BOX_STORE,
  MAX_BOX_VALUE,
} from "@hatbot/shared";
import { type CreateParams, type ModelClient, modelErrorText, oneShot } from "./agent/model";
import { sameText, secretKey } from "./auth/keys";
import type { Db } from "./db";
import { UserError } from "./errors";
import type { EventBus } from "./events";
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

/** How long an address to open a box's page holds. */
const OPEN_MS = 10 * 60_000;

/** hatbox.ask's model, and what it may write when the page doesn't say, thinking included. */
export const BOX_ASK_MODEL = "claude-haiku-5-5";
const ASK_TOKENS = 4000;

/** What hatbox.ask needs: the boxes get it once the services it needs exist (connect). */
export type BoxDeps = {
  settings: SettingsStore;
  spend: Spend;
  /** The background model, for hatbox.ask. */
  model: ModelClient;
};

export class Boxes {
  private key: Buffer;
  private d: BoxDeps | null = null;
  /** What hatbox.ask's answers on their way may still cost, held against the boxes' daily limit. */
  private asking = 0;

  constructor(
    private db: Db,
    private events: EventBus,
    private clock: () => number = Date.now,
  ) {
    this.key = secretKey(db, "box_key");
  }

  private now() {
    return new Date(this.clock()).toISOString();
  }

  /** Called once the services hatbox.ask needs exist. */
  connect(d: BoxDeps) {
    this.d = d;
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
    return { ...box, versions };
  }

  /** A version's page, the current one unless `n` is given. */
  page(id: number, n?: number): BoxPage | null {
    const v =
      n ??
      this.db.query<{ version: number }, [number]>("SELECT version FROM boxes WHERE id = ?").get(id)
        ?.version;
    if (v === undefined) return null;
    return (
      this.db
        .query<BoxPage, [number, number]>(
          `SELECT ${VERSION_COLUMNS}, html FROM box_versions WHERE box_id = ? AND n = ?`,
        )
        .get(id, v) ?? null
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
    b: { botId: string; conversationId: number | null; title: string; html: string },
    made: Made,
  ): Box {
    const now = this.now();
    const id = this.db.transaction(() => {
      const row = this.db
        .query<{ id: number }, [string, number | null, string, string, string]>(
          `INSERT INTO boxes (bot_id, conversation_id, title, version, created_at, updated_at)
           VALUES (?, ?, ?, 1, ?, ?) RETURNING id`,
        )
        .get(b.botId, b.conversationId, b.title, now, now);
      const id = row?.id ?? -1;
      this.addVersion(id, 1, b.title, b.html, made, now);
      return id;
    })();
    return this.changed(id);
  }

  /** A new version with this title and page, which opens from now on; null when neither changed. */
  save(id: number, title: string, html: string, made: Made): Box | null {
    const current = this.page(id);
    if (!current) throw new BoxError(`There's no box #${id}.`);
    if (current.title === title && current.html === html) return null;
    const now = this.now();
    this.db.transaction(() => {
      const last = this.db
        .query<{ n: number }, [number]>("SELECT MAX(n) AS n FROM box_versions WHERE box_id = ?")
        .get(id);
      const n = (last?.n ?? 0) + 1;
      this.addVersion(id, n, title, html, made, now);
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
    return this.save(id, old.title, old.html, made);
  }

  private addVersion(id: number, n: number, title: string, html: string, made: Made, now: string) {
    this.db
      .query(
        `INSERT INTO box_versions (box_id, n, title, html, message_id, tainted_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, n, title, html, made.messageId ?? null, made.taintedBy ?? null, now);
  }

  /** Every version and what its page saved go with it. */
  delete(id: number): boolean {
    const gone = this.db.transaction(() => {
      this.db.query("UPDATE messages SET box_id = NULL WHERE box_id = ?").run(id);
      return this.db.query("DELETE FROM boxes WHERE id = ?").run(id).changes > 0;
    })();
    if (gone) this.events.emit({ type: "box.deleted", id });
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
 * other pages open in a new tab, since the frame can't leave the box.
 */
const HATBOX = `(() => {
  const root = document.documentElement;
  const theme = { dark: __DARK__ };
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
  const call = (op, args) => {
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
    theme,
  });
})();`;

/** A box's page with Hatbox's styles and script first: after a doctype, so it keeps standards mode. */
export function framed(html: string, dark: boolean): string {
  const head = `<style>${BASE_CSS}</style><script>${HATBOX.replace("__DARK__", String(dark))}</script>`;
  const at = /^\s*<!doctype[^>]*>/i.exec(html)?.[0].length ?? 0;
  return html.slice(0, at) + head + html.slice(at);
}
