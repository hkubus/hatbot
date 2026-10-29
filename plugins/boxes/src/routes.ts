import { bodyOf, found, idParam, pluginRoutes } from "@hatbot/plugin-sdk";
import { BoxCall, OpenBox, RevertBox, SetBoxSecrets } from "@hatbot/shared";
import { type Boxes, FRAME_CSP } from "./boxes";

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

const GONE = { error: "That box is gone." };

export function routes(boxes: Boxes) {
  return (
    pluginRoutes()
      // The page: no session, the signed address is the authority, for a while.
      .get("/boxes/:id/frame", (c) => {
        const q = (k: string) => c.req.query(k) ?? "";
        const page = boxes.frame(
          idParam(c),
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
      .get("/boxes", (c) => c.json(boxes.list()))
      .get("/boxes/:id", (c) => {
        const box = boxes.detail(idParam(c));
        return found(c, box, GONE.error);
      })
      .get("/boxes/:id/versions/:n", (c) => {
        const page = boxes.page(idParam(c), Number(c.req.param("n")));
        return found(c, page, GONE.error);
      })
      .get("/boxes/:id/preview", async (c) => {
        const png = await boxes.preview(idParam(c), c.req.query("dark") === "1");
        if (!png) return c.json({ error: "There's no picture of that box." }, 404);
        return new Response(png, {
          headers: { "content-type": "image/png", "cache-control": "private, no-cache" },
        });
      })
      .post("/boxes/:id/open", async (c) => {
        const { version, dark } = await bodyOf(c, OpenBox);
        const box = boxes.get(idParam(c));
        const n = version ?? box?.version;
        if (!box || !n || !boxes.page(box.id, n)) return c.json(GONE, 404);
        return c.json({ url: boxes.address(box.id, n, dark ?? false) });
      })
      // Your own revert, as a new version: what tainted work wrote stays marked on the box.
      .post("/boxes/:id/revert", async (c) => {
        const { version } = await bodyOf(c, RevertBox);
        if (!boxes.get(idParam(c))) return c.json(GONE, 404);
        boxes.revert(idParam(c), version, { messageId: null });
        const box = boxes.detail(idParam(c));
        return found(c, box, GONE.error);
      })
      // Yours to set, on the box's page: only its backend gets them, and no answer carries a value.
      .put("/boxes/:id/secrets", async (c) => {
        const { values } = await bodyOf(c, SetBoxSecrets);
        if (!boxes.get(idParam(c))) return c.json(GONE, 404);
        return c.json(await boxes.setSecrets(idParam(c), values));
      })
      .post("/boxes/:id/call", async (c) => {
        const call = await bodyOf(c, BoxCall);
        if (!boxes.get(idParam(c))) return c.json(GONE, 404);
        return c.json(await boxes.call(idParam(c), call));
      })
      .delete("/boxes/:id", (c) =>
        boxes.delete(idParam(c)) ? c.json({ ok: true }) : c.json(GONE, 404),
      )
  );
}
