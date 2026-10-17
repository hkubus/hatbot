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
import { BotError } from "../bots";
import type { AppEnv } from "../context";
import { json, query, signedOut } from "./util";

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
const EpisodeIds = z.object({ ids: z.string().regex(/^\d+(,\d+){0,199}$/) });

export const threadRoutes = new Hono<AppEnv>()
  .use("/thread/*", requireAuth)
  .use("/conversations", requireAuth)
  .use("/conversations/*", requireAuth)
  .use("/attachments", requireAuth)
  .use("/attachments/*", requireAuth)
  // A file for your next message: uploaded first, then posted with it by id.
  .post("/attachments", async (c) => {
    if (Number(c.req.header("content-length") ?? 0) > MAX_ATTACHMENT_BYTES + 64 * 1024)
      return c.json({ error: "The file is over 25 MB." }, 413);
    const form = await c.req.formData().catch(() => null);
    if (signedOut(c)) return c.json({ error: "unauthorized" }, 401);
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
    const file = a && c.var.attachments.file(id);
    if (!a || !file || !(await file.exists())) return c.json({ error: "That's gone." }, 404);
    const inline = INLINE.includes(a.mediaType) && c.req.query("download") === undefined;
    const ascii = a.name.replace(/[^\x20-\x7e]|["\\]/g, "_");
    // Checked each time rather than kept for a year: an incognito one isn't kept at all.
    const etag = `"${a.id}-${Date.parse(a.createdAt).toString(36)}-${a.size.toString(36)}"`;
    const cache = c.var.attachments.cacheable(id) ? "private, no-cache" : "no-store";
    if (cache !== "no-store" && c.req.header("if-none-match") === etag)
      return new Response(null, { status: 304, headers: { etag, "cache-control": cache } });
    return new Response(file, {
      headers: {
        "content-type": inline ? a.mediaType : "application/octet-stream",
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
  .get("/conversations", (c) => c.json(c.var.chats.list()))
  // Group chats (PLAN.md §14.4): bots' own chats come and go with the bots.
  .post("/conversations", json(CreateGroup), (c) => {
    const { title, botIds } = c.req.valid("json");
    return groupError(() => c.json(c.var.chats.createGroup(title, botIds), 201), c);
  })
  .patch("/conversations/:id", json(UpdateGroup), (c) =>
    groupError(() => {
      const group = c.var.chats.updateGroup(Number(c.req.param("id")), c.req.valid("json"));
      return group ? c.json(group) : c.json({ error: "That's gone." }, 404);
    }, c),
  )
  .delete("/conversations/:id", (c) =>
    c.var.chats.deleteGroup(Number(c.req.param("id")))
      ? c.json({ ok: true })
      : c.json({ error: "That's gone." }, 404),
  )
  .get("/thread/messages", query(ListMessages), (c) => listMessages(c, c.var.chats.hatbot()))
  .get("/conversations/:id/messages", query(ListMessages), (c) =>
    withThread(c, (t) => listMessages(c, t)),
  )
  // The conversations messages belong to, for their recaps where they fold up.
  .get("/thread/episodes", query(EpisodeIds), (c) => episodes(c, c.var.chats.hatbot()))
  .get("/conversations/:id/episodes", query(EpisodeIds), (c) =>
    withThread(c, (t) => episodes(c, t)),
  )
  // Deleting a conversation from the chat for good.
  .delete("/thread/episodes/:episodeId", (c) => deleteEpisode(c, c.var.chats.hatbot()))
  .delete("/conversations/:id/episodes/:episodeId", (c) =>
    withThread(c, (t) => deleteEpisode(c, t)),
  )
  .post("/thread/messages", json(PostMessage), (c) => post(c, c.var.chats.hatbot()))
  .post("/conversations/:id/messages", json(PostMessage), (c) => withThread(c, (t) => post(c, t)))
  // A reply that failed, written again in place from where it was.
  .post("/thread/messages/:messageId/retry", (c) => retry(c, c.var.chats.hatbot()))
  .post("/conversations/:id/messages/:messageId/retry", (c) => withThread(c, (t) => retry(c, t)))
  // Shortcuts and Siri: posts like /thread/messages, then waits a while for the answer.
  .post("/thread/ask", json(PostMessage), (c) => ask(c, c.var.chats.hatbot()))
  .post("/conversations/:id/ask", json(PostMessage), (c) => withThread(c, (t) => ask(c, t)))
  // Leaving incognito: its conversation is deleted.
  .delete("/thread/incognito", async (c) => {
    await c.var.chats.hatbot().endIncognito();
    return c.json({ ok: true });
  })
  .delete("/conversations/:id/incognito", (c) =>
    withThread(c, async (t) => {
      await t.endIncognito();
      return c.json({ ok: true });
    }),
  )
  // Unread: your bots' messages, in every chat, sent or edited since you last saw them.
  .get("/thread/unread", (c) => c.json(c.var.chats.unread()))
  .post("/thread/seen", json(SeenMessages), (c) => {
    c.var.chats.markSeen(c.req.valid("json").ids);
    return c.json({ ok: true });
  });

// biome-ignore lint/suspicious/noExplicitAny: the handlers' contexts differ only in their validated input.
type Ctx = Context<AppEnv, string, any>;

function groupError(f: () => Response, c: Ctx): Response {
  try {
    return f();
  } catch (err) {
    if (err instanceof BotError) return c.json({ error: err.message }, 400);
    throw err;
  }
}

function withThread(c: Ctx, f: (t: Thread) => Response | Promise<Response>) {
  const id = Number(c.req.param("id"));
  const thread = Number.isInteger(id) ? c.var.chats.thread(id) : null;
  return thread ? f(thread) : c.json({ error: "That's gone." }, 404);
}

/** A deleted bot's chat is gone from the app; a page still showing it can't start the bot again. */
const closed = (c: Ctx, t: Thread) =>
  c.var.chats.closed(t.conversationId)
    ? c.json({ error: "That bot was deleted, so its chat takes no new messages." }, 410)
    : null;

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
    console.error("deleting a conversation failed", err);
    return c.json({ error: "Couldn't take it out of the summary. Nothing was deleted." }, 502);
  }
}

/** How long a message posted with a client id is remembered by it. */
export const SENT_FOR_MS = 10 * 60_000;
// Each chat's messages posted with a client id, by that id: one sent again because its answer was lost
// gets the same answer, and isn't posted (and replied to) twice.
const sentIn = new WeakMap<Thread, Map<string, { message: ThreadMessage; at: number }>>();

function post(c: Ctx, t: Thread) {
  const { text, attachmentIds, incognito, clientId } = c.req.valid("json" as never) as z.infer<
    typeof PostMessage
  >;
  const sent = sentIn.get(t) ?? new Map<string, { message: ThreadMessage; at: number }>();
  sentIn.set(t, sent);
  const now = Date.now();
  // Oldest first: the expired ones, and any past 200.
  for (const [id, s] of sent) {
    if (now - s.at < SENT_FOR_MS && sent.size <= 200) break;
    sent.delete(id);
  }
  const before = clientId ? sent.get(clientId) : undefined;
  if (before) return c.json(before.message, 202);
  if (attachmentIds.some((id) => c.var.attachments.get(id)?.from !== "owner"))
    return c.json({ error: "unknown attachment" }, 400);
  if (incognito && t.group()) return c.json({ error: "Group chats have no incognito." }, 400);
  const gone = closed(c, t);
  if (gone) return gone;
  const { message } = t.post(text, attachmentIds, incognito);
  if (clientId) sent.set(clientId, { message, at: now });
  return c.json(message, 202);
}

/** How long /ask waits for the reply before it answers with what's there. */
export const ASK_WAIT_MS = 25_000;

async function ask(c: Ctx, t: Thread) {
  const { text, attachmentIds, incognito } = c.req.valid("json" as never) as z.infer<
    typeof PostMessage
  >;
  if (attachmentIds.some((id) => c.var.attachments.get(id)?.from !== "owner"))
    return c.json({ error: "unknown attachment" }, 400);
  if (incognito && t.group()) return c.json({ error: "Group chats have no incognito." }, 400);
  const gone = closed(c, t);
  if (gone) return gone;
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
