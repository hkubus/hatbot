// Files in the chat: ones you attach to a message, and ones Hatbot or a task sends you. The bytes live in
// the archive; the model reads images, PDFs and text directly, and code_run can copy any of them into
// the desktop's sandbox.
import type Anthropic from "@anthropic-ai/sdk";
import type { Attachment, ThreadMessage } from "@hatbot/shared";
import type { Archive } from "./archive";
import type { Db } from "./db";
import { type DesktopAgent, DesktopError } from "./desktop/client";
import type { EventBus } from "./events";

type BlockParam = Anthropic.Beta.BetaContentBlockParam;
/** A file in a stored turn, by id (see Attachments.refs). Never sent to the API as is. */
const ATTACHMENT_REF = "hatbot_attachment";
const isRef = (b: unknown): b is { type: typeof ATTACHMENT_REF; id: number } =>
  (b as { type?: string }).type === ATTACHMENT_REF;

/** The most one file may be. */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
/** The API's limit for an image, and a PDF's share of a request. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_PDF_BYTES = 20 * 1024 * 1024;
/** Text files the model reads whole; longer ones go through the sandbox. */
const MAX_TEXT_BYTES = 400 * 1024;
/**
 * What one conversation's files may add to every request, as base64 and text: well under the API's
 * 32 MB a request. Files past it go through the sandbox. Tests lower it.
 */
export const inlineLimit = { bytes: 20 * 1024 * 1024 };

const IMAGES = ["image/jpeg", "image/png", "image/gif", "image/webp"];
const BY_EXTENSION: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  json: "application/json",
  yaml: "application/yaml",
  yml: "application/yaml",
  xml: "application/xml",
  html: "text/html",
  log: "text/plain",
  zip: "application/zip",
};
/** Text that isn't text/*: configs, data and code. */
const TEXT_TYPES = [
  "application/json",
  "application/yaml",
  "application/xml",
  "application/x-sh",
  "application/javascript",
  "application/toml",
];
const CODE_EXTENSIONS =
  /\.(ts|tsx|js|jsx|py|sh|bash|go|rs|swift|c|h|cpp|java|kt|rb|php|sql|toml|ini|conf|cfg|env|nix|lua|dockerfile)$/i;

/** The type to trust for a file: what the client said unless it's generic, else the extension's. */
export function mediaTypeOf(name: string, claimed: string): string {
  const type = claimed.split(";")[0]?.trim().toLowerCase() ?? "";
  if (type && type !== "application/octet-stream") return type;
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? "";
  if (BY_EXTENSION[ext]) return BY_EXTENSION[ext];
  return CODE_EXTENSIONS.test(name) ? "text/plain" : "application/octet-stream";
}

const isText = (a: Attachment) =>
  a.mediaType.startsWith("text/") ||
  TEXT_TYPES.includes(a.mediaType) ||
  CODE_EXTENSIONS.test(a.name);

const labelOf = (a: Attachment) =>
  `Attachment #${a.id}: "${a.name}" (${a.mediaType}, ${sizeText(a.size)})`;

/** What a file's blocks add to a request: their base64 and text documents. */
const inlineBytes = (blocks: BlockParam[]) =>
  blocks.reduce((n, b) => {
    const source = (b as { source?: { type?: string; data?: unknown } }).source;
    return n + (typeof source?.data === "string" ? source.data.length : 0);
  }, 0);

/** "2.1 MB", "340 KB". */
export const sizeText = (n: number) =>
  n >= 1024 * 1024
    ? `${(n / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(n / 1024))} KB`;

type Row = Omit<Attachment, "forChat"> & {
  path: string;
  messageId: number | null;
  taskId: number | null;
  forChat: number;
};
const COLUMNS =
  'id, name, media_type AS mediaType, size, sender AS "from", created_at AS createdAt, path, message_id AS messageId, task_id AS taskId, for_chat AS forChat';
const plain = ({ path: _p, messageId: _m, taskId: _t, forChat, ...a }: Row): Attachment =>
  forChat ? { ...a, forChat: true } : a;

export class Attachments {
  constructor(
    private d: { db: Db; archive: Archive; events: EventBus },
    private clock: () => number = Date.now,
  ) {}

  /**
   * Stores a file. Yours wait unbound until the message they go with is posted; Hatbot's go straight
   * onto a message or a task. One `forChat` isn't shown in the chat: a task's is for the bot there, and
   * a message's is the data for a chart in it (chart-data.ts).
   */
  async save(input: {
    bytes: Uint8Array;
    name: string;
    mediaType: string;
    from: "owner" | "hatbot";
    messageId?: number;
    taskId?: number;
    forChat?: boolean;
  }): Promise<Attachment> {
    const name = input.name.replace(/[\r\n/\\]/g, "_").slice(0, 200) || "file";
    const row = this.d.db
      .query<
        { id: number },
        [number | null, number | null, number, string, string, number, string, string]
      >(
        `INSERT INTO attachments (message_id, task_id, for_chat, name, media_type, size, path, sender, created_at)
         VALUES (?, ?, ?, ?, ?, ?, '', ?, ?) RETURNING id`,
      )
      .get(
        input.messageId ?? null,
        input.taskId ?? null,
        input.forChat ? 1 : 0,
        name,
        mediaTypeOf(name, input.mediaType),
        input.bytes.byteLength,
        input.from,
        new Date(this.clock()).toISOString(),
      );
    if (!row) throw new Error("attachment insert failed");
    const path = await this.d.archive.saveFile(row.id, name, input.bytes);
    this.d.db.query("UPDATE attachments SET path = ? WHERE id = ?").run(path, row.id);
    const a = this.get(row.id) as Attachment;
    if (input.messageId && !input.forChat)
      this.d.events.emit({ type: "message.attachment", id: input.messageId, attachment: a });
    // A task's file shows on the messages that show the task.
    if (input.taskId && !input.forChat) {
      const shown = this.d.db
        .query<{ id: number }, [number]>("SELECT id FROM messages WHERE task_id = ?")
        .all(input.taskId);
      for (const m of shown)
        this.d.events.emit({ type: "message.attachment", id: m.id, attachment: a });
    }
    return a;
  }

  /**
   * Sends the owner a file from the desktop: one in the sandbox shell (`path`), or a browser download.
   * Errors are DesktopErrors, fine to show the model.
   */
  async fromDesktop(
    agent: DesktopAgent,
    src: { path?: string; download?: string; name?: string },
    target: { messageId?: number; taskId?: number; forChat?: boolean },
  ): Promise<Attachment> {
    let file: { name: string; bytes: Uint8Array };
    if (src.download) file = await agent.getDownload(src.download);
    else if (src.path)
      file = { name: src.path.split("/").pop() || "file", bytes: await agent.getFile(src.path) };
    else throw new DesktopError("Give a path or a download id.", 400);
    if (file.bytes.byteLength > MAX_ATTACHMENT_BYTES)
      throw new DesktopError("The file is over 25 MB.", 400);
    const name = src.name?.trim() || file.name;
    return this.save({ bytes: file.bytes, name, mediaType: "", from: "hatbot", ...target });
  }

  get(id: number): Attachment | null {
    const row = this.row(id);
    return row ? plain(row) : null;
  }

  /**
   * Whether the file may be kept in the browser's cache: not one from an incognito conversation, nor
   * one uploaded and not yet sent, which may be going to one.
   */
  cacheable(id: number): boolean {
    const row = this.d.db
      .query<
        { message_id: number | null; task_id: number | null; incognito: number | null },
        [number]
      >(
        `SELECT a.message_id, a.task_id, m.incognito FROM attachments a
         LEFT JOIN messages m ON m.id = a.message_id WHERE a.id = ?`,
      )
      .get(id);
    if (!row) return false;
    return row.message_id !== null ? row.incognito === 0 : row.task_id !== null;
  }

  /** The file's bytes on disk, or null. */
  file(id: number) {
    const row = this.row(id);
    return row?.path ? this.d.archive.file(row.path) : null;
  }

  async bytes(id: number): Promise<Uint8Array | null> {
    const f = this.file(id);
    return f && (await f.exists()) ? new Uint8Array(await f.arrayBuffer()) : null;
  }

  /** Puts your uploaded files on your message. Ones already on a message, or Hatbot's, are skipped. */
  bind(ids: number[], messageId: number): Attachment[] {
    if (!ids.length) return [];
    return this.d.db
      .query<Row, number[]>(
        `UPDATE attachments SET message_id = ? WHERE id IN (${ids.map(() => "?").join(", ")})
         AND message_id IS NULL AND task_id IS NULL AND sender = 'owner' RETURNING ${COLUMNS}`,
      )
      .all(messageId, ...ids)
      .map(plain);
  }

  /** Deletes the files on these messages, rows and bytes, so the messages can go too. */
  async removeFor(messageIds: number[]) {
    if (!messageIds.length) return;
    const rows = this.d.db
      .query<{ path: string }, number[]>(
        `DELETE FROM attachments WHERE message_id IN (${messageIds.map(() => "?").join(", ")}) RETURNING path`,
      )
      .all(...messageIds);
    await Promise.all(rows.map((r) => r.path && this.d.archive.remove(r.path)));
  }

  /** Each message with its files: its own, and those the task it shows sent you. */
  fill(messages: ThreadMessage[]): ThreadMessage[] {
    if (!messages.length) return messages;
    const ids = messages.map((m) => m.id);
    const taskIds = messages.flatMap((m) => (m.taskId ? [m.taskId] : []));
    const rows = this.d.db
      .query<Row, number[]>(
        `SELECT ${COLUMNS} FROM attachments WHERE for_chat = 0 AND (message_id IN (${ids.map(() => "?").join(", ")})
         ${taskIds.length ? `OR task_id IN (${taskIds.map(() => "?").join(", ")})` : ""}) ORDER BY id`,
      )
      .all(...ids, ...taskIds);
    if (!rows.length) return messages;
    return messages.map((m) => {
      const mine = rows.filter((r) => r.messageId === m.id || (m.taskId && r.taskId === m.taskId));
      return mine.length ? { ...m, attachments: mine.map(plain) } : m;
    });
  }

  /** Every file these tasks sent: you, or the bot in the chat. */
  ofTasks(taskIds: number[]): (Attachment & { taskId: number })[] {
    if (!taskIds.length) return [];
    return this.d.db
      .query<Row, number[]>(
        `SELECT ${COLUMNS} FROM attachments WHERE task_id IN (${taskIds.map(() => "?").join(", ")}) ORDER BY id`,
      )
      .all(...taskIds)
      .map((r) => ({ ...plain(r), taskId: r.taskId as number }));
  }

  forTask(taskId: number): Attachment[] {
    return this.d.db
      .query<Row, [number]>(`SELECT ${COLUMNS} FROM attachments WHERE task_id = ? ORDER BY id`)
      .all(taskId)
      .map(plain);
  }

  /**
   * What the model gets for your files: images and PDFs as themselves, text inline, and for anything
   * else a line saying how to reach it.
   */
  /**
   * What a stored turn keeps for your files: their ids, not their bytes. `expand` turns them back
   * into blocks for each request, the same every time, so the prompt cache still matches.
   */
  refs(list: Attachment[]): BlockParam[] {
    return list.map((a) => ({ type: ATTACHMENT_REF, id: a.id }) as unknown as BlockParam);
  }

  /**
   * Turns with their file references made into what the model reads. `cache` lasts a reply. Files are
   * read oldest first until inlineLimit is used up; later ones are named, for code_run. Earlier turns
   * come out the same every time, so the prompt cache still matches.
   */
  async expand(
    turns: Anthropic.Beta.BetaMessageParam[],
    cache = new Map<number, BlockParam[]>(),
  ): Promise<Anthropic.Beta.BetaMessageParam[]> {
    const out: Anthropic.Beta.BetaMessageParam[] = [];
    let inline = 0;
    for (const turn of turns) {
      if (typeof turn.content === "string" || !turn.content.some(isRef)) {
        out.push(turn);
        continue;
      }
      const content: BlockParam[] = [];
      for (const b of turn.content as unknown[]) {
        if (!isRef(b)) {
          content.push(b as BlockParam);
          continue;
        }
        let blocks = cache.get(b.id);
        const a = this.get(b.id);
        if (!blocks) {
          blocks = a
            ? await this.blocks([a])
            : [{ type: "text", text: `Attachment #${b.id}: deleted.` }];
          cache.set(b.id, blocks);
        }
        const size = inlineBytes(blocks);
        if (a && size && inline + size > inlineLimit.bytes) {
          content.push({
            type: "text",
            text: `${labelOf(a)}: not read here, as it would take this conversation's files past what one request can carry. code_run can copy it into the sandbox (files: [${a.id}]) to work on it.`,
          });
          continue;
        }
        inline += size;
        content.push(...blocks);
      }
      out.push({ ...turn, content });
    }
    return out;
  }

  async blocks(list: Attachment[]): Promise<Anthropic.Beta.BetaContentBlockParam[]> {
    const out: Anthropic.Beta.BetaContentBlockParam[] = [];
    for (const a of list) {
      const label = labelOf(a);
      const bytes = await this.bytes(a.id);
      if (!bytes) {
        out.push({ type: "text", text: `${label}: the file is missing.` });
        continue;
      }
      const b64 = () => Buffer.from(bytes).toString("base64");
      if (IMAGES.includes(a.mediaType) && a.size <= MAX_IMAGE_BYTES) {
        out.push({ type: "text", text: label });
        out.push({
          type: "image",
          source: { type: "base64", media_type: a.mediaType as "image/png", data: b64() },
        });
      } else if (a.mediaType === "application/pdf" && a.size <= MAX_PDF_BYTES) {
        out.push({ type: "text", text: label });
        out.push({
          type: "document",
          title: a.name,
          source: { type: "base64", media_type: "application/pdf", data: b64() },
        });
      } else if (isText(a) && a.size <= MAX_TEXT_BYTES) {
        out.push({ type: "text", text: label });
        out.push({
          type: "document",
          title: a.name,
          source: { type: "text", media_type: "text/plain", data: new TextDecoder().decode(bytes) },
        });
      } else {
        out.push({
          type: "text",
          text: `${label}: too big or not a kind you can read directly. code_run can copy it into the sandbox (files: [${a.id}]) to work on it.`,
        });
      }
    }
    return out;
  }

  private row(id: number): Row | null {
    return this.d.db
      .query<Row, [number]>(`SELECT ${COLUMNS} FROM attachments WHERE id = ?`)
      .get(id);
  }
}
