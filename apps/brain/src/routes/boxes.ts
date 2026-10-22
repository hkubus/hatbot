import { BoxCall, OpenBox, RevertBox, SetBoxSecrets } from "@hatbot/shared";
import { Hono } from "hono";
import { requireAuth } from "../auth/middleware";
import { FRAME_CSP } from "../boxes";
import type { AppEnv } from "../context";
import { found, id, json } from "./util";

/**
 * A box's page runs on an opaque origin (the CSP's sandbox, whether framed or opened on its own), so it
 * has neither the app's session nor its storage, and it reaches nothing outside itself: hatbox.store
 * goes through the app. Popups escape the sandbox, so the pages a box links to work.
 */
const FRAME_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy": FRAME_CSP,
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cross-origin-resource-policy": "same-origin",
  "cache-control": "no-store",
};

const GONE = "That box is gone.";

export const boxRoutes = new Hono<AppEnv>()
  // The page: no session, the signed address is the authority, for a while.
  .get("/boxes/:id/frame", (c) => {
    const q = (k: string) => c.req.query(k) ?? "";
    const page = c.var.boxes.frame(
      id(c),
      Number(q("v")),
      Number(q("exp")),
      q("sig"),
      q("dark") === "1",
    );
    if (page === null)
      return new Response("This link has expired. Open the box again in Hatbot.", {
        status: 403,
        headers: { ...FRAME_HEADERS, "content-type": "text/plain; charset=utf-8" },
      });
    return new Response(page, { headers: FRAME_HEADERS });
  })
  .use("/boxes", requireAuth)
  .use("/boxes/*", requireAuth)
  .get("/boxes", (c) => c.json(c.var.boxes.list()))
  .get("/boxes/:id", (c) => found(c, c.var.boxes.detail(id(c)), GONE))
  .get("/boxes/:id/versions/:n", (c) =>
    found(c, c.var.boxes.page(id(c), Number(c.req.param("n"))), GONE),
  )
  .get("/boxes/:id/preview", async (c) => {
    const png = await c.var.boxes.preview(id(c), c.req.query("dark") === "1", c.var.desktop.agent);
    if (!png) return c.json({ error: "There's no picture of that box." }, 404);
    return new Response(png, {
      headers: { "content-type": "image/png", "cache-control": "private, no-cache" },
    });
  })
  .post("/boxes/:id/open", json(OpenBox), (c) => {
    const { version, dark } = c.req.valid("json");
    const box = c.var.boxes.get(id(c));
    const n = version ?? box?.version;
    if (!box || !n || !c.var.boxes.page(box.id, n)) return c.json({ error: GONE }, 404);
    return c.json({ url: c.var.boxes.address(box.id, n, dark ?? false) });
  })
  // Your own revert, as a new version: what tainted work wrote stays marked on the box.
  .post("/boxes/:id/revert", json(RevertBox), (c) => {
    const { boxes } = c.var;
    if (!boxes.get(id(c))) return c.json({ error: GONE }, 404);
    boxes.revert(id(c), c.req.valid("json").version, { messageId: null });
    return found(c, boxes.detail(id(c)), GONE);
  })
  // Yours to set, on the box's page: only its backend gets them, and no answer carries a value.
  .put("/boxes/:id/secrets", json(SetBoxSecrets), async (c) => {
    const { boxes } = c.var;
    if (!boxes.get(id(c))) return c.json({ error: GONE }, 404);
    return c.json(await boxes.setSecrets(id(c), c.req.valid("json").values));
  })
  .post("/boxes/:id/call", json(BoxCall), async (c) => {
    const { boxes } = c.var;
    if (!boxes.get(id(c))) return c.json({ error: GONE }, 404);
    return c.json(await boxes.call(id(c), c.req.valid("json")));
  })
  .delete("/boxes/:id", (c) =>
    c.var.boxes.delete(id(c)) ? c.json({ ok: true }) : c.json({ error: GONE }, 404),
  );
