import {
  CreateGroup,
  PostMessage,
  SeenMessages,
  type ThreadMessage,
  UpdateGroup,
} from "@hatbot/shared";
import { type Context, Hono } from "hono";
import { z } from "zod";
import type { Thread } from "../agent/thread";
import { MAX_ATTACHMENT_BYTES } from "../attachments";
import { requireAuth } from "../auth/middleware";
import { chartData } from "../chart-data";
import type { AppEnv } from "../context";
import { BudgetError } from "../spend";
import { found, id, json, query, signedOut } from "./util";

/** RFC 5987's encoding for filename*: encodeURIComponent leaves ' ( ) * as they are, which it doesn't allow. */
const rfc5987 = (s: string) =>
  encodeURIComponent(s).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** Types shown in the page: anything else downloads, so a file can't run script on the app's origin. */
const INLINE = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "application/pdf",
  "text/plain",
];

const ListMessages = z.object({
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  incognito: z.enum(["0", "1"]).optional(),
});
const MessageRange = z.object({
  from: z.coerce.number().int().positive(),
  before: z.coerce.number().int().positive(),
  since: z.iso.datetime(),
  incognito: z.enum(["0", "1"]).optional(),
});
const EpisodeIds = z.object({ ids: z.string().regex(/^\d+(,\d+){0,199}$/) });
const ChartQuery = z.object({ type: z.enum(["line", "bar", "scatter"]) });

export const threadRoutes = new Hono<AppEnv>()
  .use("/thread/*", requireAuth)
  .use("/conversations", requireAuth)
  .use("/conversations/*", requireAuth)
  .use("/attachments", requireAuth)
  .use("/attachments/*", requireAuth)
  .post("/attachments", async (c) => {
    if (Number(c.req.header("content-length") ?? 0) > MAX_ATTACHMENT_BYTES + 64 * 1024)
      return c.json({ error: "The file is over 25 MB." }, 413);
    const form = await c.req.formData().catch(() => null);
    if (signedOut(c)) return c.json({ error: "You're not signed in." }, 401);
    const file = form?.get("file");
    if (!(file instanceof File))
      return c.json({ error: 'Send the file as multipart field "file".' }, 400);
    if (file.size > MAX_ATTACHMENT_BYTES) return c.json({ error: "The file is over 25 MB." }, 413);
    if (file.size === 0) return c.json({ error: "The file is empty." }, 400);
    const attachment = await c.var.attachments.save({
      bytes: new Uint8Array(await file.arrayBuffer()),
      name: file.name || "file",
      mediaType: file.type,
      from: "owner",
    });
    return c.json(attachment, 201);
  })
  .get("/attachments/:id", async (c) => {
    const id = Number(c.req.param("id"));
    const a = Number.isInteger(id) ? c.var.attachments.get(id) : null;
    const original = a && c.var.attachments.file(id);
    if (!a || !original || !(await original.exists()))
      return c.json({ error: "That's gone." }, 404);
    const download = c.req.query("download") !== undefined;
    const w = Number(c.req.query("w"));
    const thumb =
      !download && Number.isInteger(w) && w > 0 ? await c.var.attachments.thumbnail(id, w) : null;
    const inline = INLINE.includes(a.mediaType) && !download;
    const ascii = a.name.replace(/[^\x20-\x7e]|["\\]/g, "_");
    const etag = `"${a.id}-${Date.parse(a.createdAt).toString(36)}-${a.size.toString(36)}${thumb ? `-${thumb.size}` : ""}"`;
    // A sent file's bytes never change, so it's kept for good; an incognito one isn't kept at all.
    const cache = c.var.attachments.cacheable(id)
      ? "private, max-age=31536000, immutable"
      : "no-store";
    if (cache !== "no-store" && c.req.header("if-none-match") === etag)
      return new Response(null, { status: 304, headers: { etag, "cache-control": cache } });
    return new Response(thumb?.file ?? original, {
      headers: {
        "content-type": thumb ? "image/webp" : inline ? a.mediaType : "application/octet-stream",
        "content-disposition": `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${rfc5987(a.name)}`,
        "x-content-type-options": "nosniff",
        "cross-origin-resource-policy": "same-origin",
        // Chromium won't open a PDF in a sandboxed page; a PDF can't reach the app either way.
        "content-security-policy": `${a.mediaType === "application/pdf" ? "" : "sandbox; "}default-src 'none'; img-src 'self'; style-src 'unsafe-inline'`,
        "cache-control": cache,
        ...(cache === "no-store" ? {} : { etag }),
      },
    });
  })
  .get("/attachments/:id/chart", query(ChartQuery), async (c) => {
    const id = Number(c.req.param("id"));
    const a = Number.isInteger(id) ? c.var.attachments.get(id) : null;
    if (!a) return c.json({ error: "That's gone." }, 404);
    const { type } = c.req.valid("query");
    const read = await chartData(c.var.attachments, id, type);
    if ("problem" in read)
      return read.gone
        ? c.json({ error: "That's gone." }, 404)
        : c.json({ error: `This chart's file doesn't draw: ${read.problem}.` }, 422);
    const etag = `"${a.id}-${Date.parse(a.createdAt).toString(36)}-${type}"`;
    const cache = c.var.attachments.cacheable(id) ? "private, no-cache" : "no-store";
    if (cache !== "no-store" && c.req.header("if-none-match") === etag)
      return new Response(null, { status: 304, headers: { etag, "cache-control": cache } });
    return c.json(read.data, 200, {
      "cache-control": cache,
      ...(cache === "no-store" ? {} : { etag }),
    });
  })
  .get("/conversations", (c) => c.json(c.var.chats.list()))
  // Bots' own chats come and go with the bots.
  .post("/conversations", json(CreateGroup), (c) => {
    const { title, botIds } = c.req.valid("json");
    return c.json(c.var.chats.createGroup(title, botIds), 201);
  })
  .patch("/conversations/:id", json(UpdateGroup), (c) =>
    found(c, c.var.chats.updateGroup(id(c), c.req.valid("json"))),
  )
  .delete("/conversations/:id", (c) =>
    c.var.chats.deleteGroup(id(c)) ? c.json({ ok: true }) : c.json({ error: "That's gone." }, 404),
  )
  .get("/thread/unread", (c) => c.json(c.var.chats.unread()))
  .post("/thread/seen", json(SeenMessages), (c) => {
    c.var.chats.markSeen(c.req.valid("json").ids);
    return c.json({ ok: true });
  });

// biome-ignore lint/suspicious/noExplicitAny: the handlers' contexts differ only in their validated input.
type Ctx = Context<AppEnv, string, any>;

// Each chat's own routes: Hatbot's at /thread/…, and any chat's at /conversations/:id/….
for (const [at, threadOf] of [
  ["/thread", (c: Ctx) => c.var.chats.hatbot()],
  ["/conversations/:id", (c: Ctx) => (Number.isInteger(id(c)) ? c.var.chats.thread(id(c)) : null)],
] as const) {
  const on = (f: (c: Ctx, t: Thread) => Response | Promise<Response>) => (c: Ctx) => {
    const thread = threadOf(c);
    return thread ? f(c, thread) : c.json({ error: "That's gone." }, 404);
  };
  threadRoutes
    .get(`${at}/messages`, query(ListMessages), on(listMessages))
    // Earlier pages an app has loaded: which messages are still there, and which were edited.
    .get(`${at}/messages/changes`, query(MessageRange), on(messageChanges))
    .get(`${at}/episodes`, query(EpisodeIds), on(episodes))
    .delete(`${at}/episodes/:episodeId`, on(deleteEpisode))
    .post(
      `${at}/episodes/:episodeId/trust`,
      on((c, t) =>
        t.trustEpisode(Number(c.req.param("episodeId")))
          ? c.json({ ok: true })
          : c.json({ error: "That's gone." }, 404),
      ),
    )
    .post(`${at}/messages`, json(PostMessage), on(post))
    .post(`${at}/messages/:messageId/retry`, on(retry))
    // Shortcuts and Siri: posts like /thread/messages, then waits a while for the answer.
    .post(`${at}/ask`, json(PostMessage), on(ask))
    .delete(
      `${at}/incognito`,
      on(async (c, t) => {
        await t.endIncognito();
        return c.json({ ok: true });
      }),
    );
}

/** A deleted bot's chat is gone from the app; a page still showing it can't start the bot again. */
const closed = (c: Ctx, t: Thread) =>
  c.var.chats.closed(t.conversationId)
    ? c.json({ error: "That bot was deleted, so its chat takes no new messages." }, 410)
    : null;

function refused(c: Ctx, t: Thread, { attachmentIds, incognito }: z.infer<typeof PostMessage>) {
  if (attachmentIds.some((id) => c.var.attachments.get(id)?.from !== "owner"))
    return c.json({ error: "unknown attachment" }, 400);
  if (incognito && t.group()) return c.json({ error: "Group chats have no incognito." }, 400);
  return closed(c, t);
}

function retry(c: Ctx, t: Thread) {
  const gone = closed(c, t);
  if (gone) return gone;
  const id = Number(c.req.param("messageId"));
  if (!Number.isInteger(id) || !t.retry(id))
    return c.json({ error: "Only the latest reply, when it failed, can be tried again." }, 409);
  return c.json({ ok: true }, 202);
}

function listMessages(c: Ctx, t: Thread) {
  const { before, limit, incognito } = c.req.valid("query" as never) as z.infer<
    typeof ListMessages
  >;
  return c.json(t.list(before, limit, incognito === "1"));
}

function messageChanges(c: Ctx, t: Thread) {
  const { from, before, since, incognito } = c.req.valid("query" as never) as z.infer<
    typeof MessageRange
  >;
  // Compared as the brain writes times, which sort as text.
  return c.json(t.changes(from, before, new Date(since).toISOString(), incognito === "1"));
}

function episodes(c: Ctx, t: Thread) {
  const { ids } = c.req.valid("query" as never) as z.infer<typeof EpisodeIds>;
  return c.json(t.episodes(ids.split(",").map(Number)));
}

async function deleteEpisode(c: Ctx, t: Thread) {
  const id = Number(c.req.param("episodeId"));
  try {
    return Number.isInteger(id) && (await t.deleteEpisode(id))
      ? c.json({ ok: true })
      : c.json({ error: "That's gone." }, 404);
  } catch (err) {
    if (err instanceof BudgetError)
      return c.json(
        {
          error: `${err.limit === "monthly" ? "This month's" : "Today's"} spending limit is used up, so it couldn't be taken out of the summary. Nothing was deleted.`,
        },
        429,
      );
    console.error("deleting a conversation failed", err);
    return c.json({ error: "Couldn't take it out of the summary. Nothing was deleted." }, 502);
  }
}

export const SENT_FOR_MS = 10 * 60_000;
// Each chat's messages posted with a client id, by that id: one sent again because its answer was lost
// gets the same answer, and isn't posted (and replied to) twice.
const sentIn = new WeakMap<Thread, Map<string, { message: ThreadMessage; at: number }>>();

function post(c: Ctx, t: Thread) {
  const body = c.req.valid("json" as never) as z.infer<typeof PostMessage>;
  const { text, attachmentIds, incognito, clientId } = body;
  const sent = sentIn.get(t) ?? new Map<string, { message: ThreadMessage; at: number }>();
  sentIn.set(t, sent);
  const now = Date.now();
  for (const [id, s] of sent) {
    if (now - s.at < SENT_FOR_MS && sent.size <= 200) break;
    sent.delete(id);
  }
  const before = clientId ? sent.get(clientId) : undefined;
  if (before) return c.json(before.message, 202);
  const no = refused(c, t, body);
  if (no) return no;
  const { message } = t.post(text, attachmentIds, incognito);
  if (clientId) sent.set(clientId, { message, at: now });
  return c.json(message, 202);
}

export const ASK_WAIT_MS = 25_000;

async function ask(c: Ctx, t: Thread) {
  const body = c.req.valid("json" as never) as z.infer<typeof PostMessage>;
  const { text, attachmentIds, incognito } = body;
  const no = refused(c, t, body);
  if (no) return no;
  const { message, done } = t.post(text, attachmentIds, incognito);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const finished = await Promise.race([
    done.then(
      () => true,
      () => true,
    ),
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), ASK_WAIT_MS);
    }),
  ]);
  clearTimeout(timer);
  const replies = t
    .list(undefined, 50, incognito)
    .filter((m) => m.id > message.id && m.role === "assistant");
  return c.json({ message, replies, finished });
}
