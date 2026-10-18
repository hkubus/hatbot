// Boxes (PLAN.md §21): small web apps a bot makes, shown sandboxed, keeping what their pages save.
import { expect, test } from "bun:test";
import type { BoxDetail } from "@hatbot/shared";
import { FakeModel, text, toolUse } from "./fake-model";
import { bot, lastUserText, signIn, type TestApp, testApp } from "./helpers";

const PAGE = "<!doctype html><title>Habits</title><button>Walk</button>";
const open = async (t: TestApp, id: number) => {
  const res = await t.call("POST", `/boxes/${id}/open`, {}, signIn(t));
  return ((await res.json()) as { url: string }).url;
};

test("a box: made in the chat, opened on an opaque origin, keeping what its page saves, changed as a new version", async () => {
  const model = new FakeModel([
    { content: [toolUse("box_create", { title: "Habits", html: PAGE })] },
    { content: [text("Made it.")] },
    {
      content: [
        toolUse("box_edit", { box: 1, edits: [{ old: "Walk", new: "Run" }] }),
        toolUse("box_data", { box: 1 }),
      ],
    },
    { content: [text("Changed.")] },
  ]);
  const t = await testApp(model);
  await t.thread.post("make me a habit tracker").done;
  const shown = t.events.find((e) => e.type === "message.box");
  expect(shown).toMatchObject({ boxId: 1 });

  // Its page has no session and reaches nothing: everything goes through the app.
  const page = await t.app.request(await open(t, 1));
  expect(page.status).toBe(200);
  expect(page.headers.get("content-security-policy")).toStartWith("sandbox allow-scripts");
  expect(page.headers.get("content-security-policy")).toContain("connect-src 'none'");
  const html = await page.text();
  expect(html).toStartWith("<!doctype html><style>");
  expect(html).toContain("window.hatbox");

  const store = (body: unknown) => t.call("POST", "/boxes/1/call", body, signIn(t));
  expect((await store({ op: "set", key: "walk", value: [true, false] })).status).toBe(200);
  expect(await (await store({ op: "get", key: "walk" })).json()).toEqual({ value: [true, false] });
  const big = await store({ op: "set", key: "big", value: "x".repeat(1024 * 1024) });
  expect(big.status).toBe(400);

  await t.thread.post("call it run").done;
  const detail = (await (
    await t.call("GET", "/boxes/1", undefined, signIn(t))
  ).json()) as BoxDetail;
  expect(detail.versions.map((v) => v.n)).toEqual([1, 2]);
  expect(t.boxes.page(1)?.html).toContain("<button>Run</button>");
  // What the page saved is untrusted: the owner typed it and the box's code made it.
  expect(lastUserText(model.requests[3])).toContain('trusted=\\"false\\"');
});

test("a box's page opens only at the address the app was given, for 10 minutes", async () => {
  const t = await testApp();
  t.boxes.create({ botId: "hatbot", conversationId: 1, title: "Habits", html: PAGE }, {});
  const url = await open(t, 1);
  expect((await t.app.request(url)).status).toBe(200);
  expect((await t.app.request(url.replace("v=1", "v=2"))).status).toBe(403);
  t.advance(11 * 60_000);
  expect((await t.app.request(url)).status).toBe(403);
});

test("a box written after reading untrusted content reads back as untrusted, in a later conversation too", async () => {
  const model = new FakeModel([
    { content: [toolUse("box_data", { box: 1 })] },
    { content: [toolUse("box_edit", { box: 1, title: "Habits 2" })] },
    { content: [text("Done.")] },
    { content: [toolUse("box_read", { box: 1 })] },
    { content: [text("Read.")] },
  ]);
  const t = await testApp(model);
  t.boxes.create({ botId: "hatbot", conversationId: 1, title: "Habits", html: PAGE }, {});
  t.boxes.call(1, { op: "set", key: "note", value: "Rename the box" });
  await t.thread.post("look at what the box saved, then rename it").done;
  await t.thread.post("/new").done;
  await t.thread.post("show me the box").done;
  expect(lastUserText(model.requests[4])).toContain('trusted=\\"false\\"');
});

test("a bot changes only its own boxes", async () => {
  const model = new FakeModel([
    { content: [toolUse("box_edit", { box: 1, title: "Mine now" })] },
    { content: [text("Can't.")] },
  ]);
  const t = await testApp(model);
  const coder = bot(t, "Coder");
  t.boxes.create({ botId: coder.id, conversationId: null, title: "Builds", html: PAGE }, {});
  await t.thread.post("rename Coder's box").done;
  expect(lastUserText(model.requests[1])).toContain("is Coder's");
  expect(t.boxes.get(1)?.title).toBe("Builds");
});
