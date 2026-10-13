import { PostMessage, SeenMessages } from "@hatbot/shared";
import { Hono } from "hono";
import { z } from "zod";
import { MAX_ATTACHMENT_BYTES } from "../attachments";
import { requireAuth } from "../auth/middleware";
import type { AppEnv } from "../context";
import { json, query } from "./util";

/** Types shown in the page: anything else downloads, so a file can't run script on the app's origin. */
const INLINE = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "application/pdf",
  "text/plain",
];

export const threadRoutes = new Hono<AppEnv>()
  .use("/thread/*", requireAuth)
  .use("/attachments", requireAuth)
  .use("/attachments/*", requireAuth)
  // A file for your next message: uploaded first, then posted with it by id.
  .post("/attachments", async (c) => {
    if (Number(c.req.header("content-length") ?? 0) > MAX_ATTACHMENT_BYTES + 64 * 1024)
      return c.json({ error: "The file is over 25 MB." }, 413);
    const form = await c.req.formData().catch(() => null);
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
    if (!a || !file || !(await file.exists())) return c.json({ error: "not found" }, 404);
    const inline = INLINE.includes(a.mediaType) && c.req.query("download") === undefined;
    const ascii = a.name.replace(/[^\x20-\x7e]|["\\]/g, "_");
    return new Response(file, {
      headers: {
        "content-type": inline ? a.mediaType : "application/octet-stream",
        "content-disposition": `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(a.name)}`,
        "x-content-type-options": "nosniff",
        // Chromium won't open a PDF in a sandboxed page; a PDF can't reach the app either way.
        "content-security-policy": `${a.mediaType === "application/pdf" ? "" : "sandbox; "}default-src 'none'; img-src 'self'; style-src 'unsafe-inline'`,
        "cache-control": "private, max-age=31536000, immutable",
      },
    });
  })
  .get(
    "/thread/messages",
    query(
      z.object({
        before: z.coerce.number().int().positive().optional(),
        limit: z.coerce.number().int().min(1).max(200).optional(),
        incognito: z.enum(["0", "1"]).optional(),
      }),
    ),
    (c) => {
      const { before, limit, incognito } = c.req.valid("query");
      return c.json(c.var.thread.list(before, limit, incognito === "1"));
    },
  )
  // The conversations messages belong to, for their recaps where they fold up.
  .get("/thread/episodes", query(z.object({ ids: z.string().regex(/^\d+(,\d+){0,199}$/) })), (c) =>
    c.json(c.var.thread.episodes(c.req.valid("query").ids.split(",").map(Number))),
  )
  .post("/thread/messages", json(PostMessage), (c) => {
    const { text, attachmentIds, incognito } = c.req.valid("json");
    if (attachmentIds.some((id) => c.var.attachments.get(id)?.from !== "owner"))
      return c.json({ error: "unknown attachment" }, 400);
    const { message } = c.var.thread.post(text, attachmentIds, incognito);
    return c.json(message, 202);
  })
  // Leaving incognito: its conversation is deleted.
  .delete("/thread/incognito", async (c) => {
    await c.var.thread.endIncognito();
    return c.json({ ok: true });
  })
  // Unread: Hatbot's messages sent or edited since you last saw them.
  .get("/thread/unread", (c) => c.json(c.var.thread.unread()))
  .post("/thread/seen", json(SeenMessages), (c) => {
    c.var.thread.markSeen(c.req.valid("json").ids);
    return c.json({ ok: true });
  });
