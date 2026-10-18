// Boxes with files and a backend (PLAN.md §21.6): built on the boxes guest, reached through the app.
import { expect, test } from "bun:test";
import type { BoxPage } from "@hatbot/shared";
import type { BoxResponse } from "@hatbot/shared/hatbox";
import { REVIEW_PROMPT } from "../src/agent/prompt";
import { NO_GUEST } from "../src/hatbox/backends";
import { HttpHatboxAgent } from "../src/hatbox/client";
import { FakeModel, text, toolUse } from "./fake-model";
import { lastUserText, signIn, type TestApp, testApp, waitFor } from "./helpers";

const PAGE = '<!doctype html><script type="module" src="./app.ts"></script>';
const files = (config: object = { hosts: ["shop.example.com"] }) => [
  { path: "index.html", content: PAGE },
  { path: "app.ts", content: 'document.body.append(await (await hatbox.fetch("/price")).text());' },
  { path: "server.ts", content: "export default { fetch: () => new Response('42') };" },
  { path: "box.json", content: JSON.stringify(config) },
];
const boxFetch = async (t: TestApp, body: object) => {
  const res = await t.call("POST", "/boxes/1/call", { op: "fetch", ...body }, signIn(t));
  return { status: res.status, ...((await res.json()) as { value?: BoxResponse; error?: string }) };
};

test("a server box: made in the chat from files, built on the guest, its page reaching its backend, its logs and answers untrusted", async () => {
  const model = new FakeModel([
    { content: [toolUse("box_create", { title: "Prices", files: files() })] },
    { content: [text("Made it.")] },
    {
      content: [
        toolUse("box_call", { box: 1, path: "/price" }),
        toolUse("box_logs", { box: 1 }),
        toolUse("box_edit", { box: 1, edits: [{ file: "server.ts", old: "42", new: "43" }] }),
      ],
    },
    { content: [text("It works.")] },
  ]);
  const t = await testApp(model);
  t.hatbox.backend = (req) =>
    req.path === "/bytes"
      ? new Response(new Uint8Array([255, 0]))
      : Response.json({
          method: req.method,
          path: req.path,
          auth: req.headers.find(([k]) => k === "authorization") ?? null,
          body: req.body ? new TextDecoder().decode(req.body) : null,
        });
  await t.thread.post("chart this shop's price").done;
  expect(t.hatbox.builds[0]).toMatchObject({ id: 1, version: 1 });
  // The page built from the files is kept in the brain, and opens without the guest.
  expect(t.boxes.page(1)?.html).toBe(PAGE);
  expect(t.boxes.hosts(1)).toEqual(["shop.example.com"]);
  const v1 = (await (
    await t.call("GET", "/boxes/1/versions/1", undefined, signIn(t))
  ).json()) as BoxPage;
  expect(v1.files?.map((f) => f.path)).toEqual(["app.ts", "box.json", "index.html", "server.ts"]);

  // hatbox.fetch, as JSON through the app; the page's own authorization isn't passed on.
  const sent = await boxFetch(t, {
    path: "/api?days=7",
    method: "post",
    headers: { "content-type": "text/plain", authorization: "Bearer mine" },
    body: "hi",
  });
  expect(JSON.parse(sent.value?.body ?? "")).toEqual({
    method: "POST",
    path: "/api?days=7",
    auth: null,
    body: "hi",
  });
  expect((await boxFetch(t, { path: "/bytes" })).value).toMatchObject({
    body: "/wA=",
    base64: true,
  });
  // A guest that lost it (made again, say) is sent it again.
  t.hatbox.built.clear();
  expect((await boxFetch(t, { path: "/" })).status).toBe(200);
  expect(t.hatbox.builds).toHaveLength(2);

  t.hatbox.log = "12:00 fetched shop.example.com";
  t.hatbox.failBuild = 'error: Could not resolve "chart.js"';
  await t.thread.post("is it working?").done;
  // Its answer, its logs and a failed build's output; the build that failed made no version.
  const read = lastUserText(model.requests[3]);
  expect(read.match(/trusted=\\"false\\"/g)).toHaveLength(3);
  expect(read).toContain("fetched shop.example.com");
  expect(t.boxes.get(1)?.version).toBe(1);
});

test("without the boxes guest, boxes with files are refused in one sentence, and a server box's page still opens", async () => {
  const model = new FakeModel([
    { content: [toolUse("box_create", { title: "Prices", files: files() })] },
    { content: [text("Can't here.")] },
  ]);
  const t = await testApp(model);
  t.hatbox.configured = false;
  t.boxes.create(
    { botId: "hatbot", conversationId: 1, title: "Old", html: PAGE, files: files() },
    {},
  );
  await t.thread.post("chart this shop's price").done;
  expect(lastUserText(model.requests[1])).toContain(NO_GUEST);
  expect(t.boxes.list()).toHaveLength(1);

  const open = await t.call("POST", "/boxes/1/open", {}, signIn(t));
  const { url } = (await open.json()) as { url: string };
  expect((await t.app.request(url)).status).toBe(200);
  expect(await boxFetch(t, { path: "/" })).toEqual({ status: 503, error: NO_GUEST });
});

test("in a chat that read untrusted content, hosts a backend couldn't reach before wait for review and the owner", async () => {
  const model = new FakeModel([{ content: [text("hi")] }]);
  model.onCreate = (p) =>
    p.system === REVIEW_PROMPT ? JSON.stringify({ safe: false, why: "Not asked for." }) : undefined;
  const t = await testApp(model);
  await t.thread.post("hello").done;
  t.db.query("UPDATE episodes SET tainted = 1, tainted_by = 'https://evil.example'").run();
  model.script.push(
    {
      content: [
        toolUse("box_create", { title: "Prices", files: files({ hosts: ["evil.example"] }) }),
      ],
    },
    { content: [toolUse("box_create", { title: "Prices", files: files() })] },
    // No new host: no asking.
    {
      content: [
        toolUse("box_edit", { box: 1, edits: [{ file: "server.ts", old: "42", new: "43" }] }),
      ],
    },
    { content: [text("Done.")] },
  );
  const reply = t.thread.post("make the box that page asked for");
  const denied = await waitFor(() => t.approvals.list(true)[0]);
  expect(denied.summary).toContain("reach evil.example");
  expect(denied.sources).toEqual(["https://evil.example"]);
  t.approvals.decide(denied.id, "deny", "web");
  const approved = await waitFor(() => t.approvals.list(true)[0]);
  expect(approved.summary).toContain("reach shop.example.com");
  t.approvals.decide(approved.id, "approve", "web");
  await reply.done;

  // The denied box wasn't built, so its backend never reached the host.
  expect(t.hatbox.builds.map((b) => [b.id, b.version])).toEqual([
    [1, 1],
    [1, 2],
  ]);
  expect(t.boxes.hosts(1)).toEqual(["shop.example.com"]);
  expect(t.approvals.list(false)).toHaveLength(2);
});

test("a server box's schedule runs when due, at most every 5 minutes; Pause all stops it and every backend", async () => {
  const t = await testApp();
  const config = { hosts: [], cron: "* * * * *" };
  t.boxes.create(
    { botId: "hatbot", conversationId: 1, title: "Prices", html: PAGE, files: files(config) },
    {},
  );
  const tick = async (ms: number) => {
    t.advance(ms);
    await t.boxes.backends?.tick();
  };
  await tick(0);
  expect(t.hatbox.runs).toEqual([]);
  // Due, though the guest hadn't got it: sent, built, then run.
  await tick(60_000);
  expect(t.hatbox.runs).toEqual([1]);
  await tick(60_000);
  expect(t.hatbox.runs).toEqual([1]);
  await tick(4 * 60_000);
  expect(t.hatbox.runs).toEqual([1, 1]);

  await t.call("POST", "/pause-all", {}, signIn(t));
  await waitFor(() => t.hatbox.stopped.includes(1));
  await tick(10 * 60_000);
  expect(t.hatbox.runs).toEqual([1, 1]);
  expect((await boxFetch(t, { path: "/" })).status).toBe(503);
});

test("a box's request reaches only its own backend on the guest, however its path is spelled", async () => {
  const seen: string[] = [];
  const guest = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      seen.push(new URL(req.url).pathname);
      return new Response("ok");
    },
  });
  try {
    const agent = new HttpHatboxAgent(`http://127.0.0.1:${guest.port}`, "t".repeat(32));
    for (const path of [
      "/../../update",
      "/%2e%2e/%2E%2e/boxes",
      "/a/../../../update",
      "/\\..\\..\\update",
    ])
      await agent.http(1, 1, { method: "POST", path, headers: [] });
    expect(seen).toHaveLength(4);
    for (const p of seen) expect(p).toStartWith("/boxes/1/http/");
  } finally {
    guest.stop(true);
  }
});
