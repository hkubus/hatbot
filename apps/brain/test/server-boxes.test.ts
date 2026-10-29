// Boxes with files and a backend: built on the boxes guest, reached through the app.
import { expect, test } from "bun:test";
import { HttpHatboxAgent, NO_GUEST } from "@hatbot/plugin-boxes";
import type { BoxPage } from "@hatbot/shared";
import type { BoxResponse } from "@hatbot/shared/hatbox";
import { REVIEW_PROMPT } from "../src/agent/prompt";
import { FakeModel, text, toolUse } from "./fake-model";
import { lastUserText, ORIGIN, signIn, type TestApp, testApp, waitFor } from "./helpers";

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
    { content: [toolUse("boxes_create", { title: "Prices", files: files() })] },
    { content: [text("Made it.")] },
    {
      content: [
        toolUse("boxes_call", { box: 1, path: "/price" }),
        toolUse("boxes_logs", { box: 1 }),
        toolUse("boxes_edit", { box: 1, edits: [{ file: "server.ts", old: "42", new: "43" }] }),
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
    { content: [toolUse("boxes_create", { title: "Prices", files: files() })] },
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

test("in a chat that read untrusted content, with the review off, hosts a backend couldn't reach before wait for the owner", async () => {
  const model = new FakeModel([{ content: [text("hi")] }]);
  const t = await testApp(model);
  t.settings.update({ reviewChanges: false });
  await t.thread.post("hello").done;
  t.db.query("UPDATE episodes SET tainted = 1, tainted_by = 'https://evil.example'").run();
  model.script.push(
    {
      content: [
        toolUse("boxes_create", { title: "Prices", files: files({ hosts: ["evil.example"] }) }),
      ],
    },
    { content: [toolUse("boxes_create", { title: "Prices", files: files() })] },
    {
      content: [
        toolUse("boxes_edit", { box: 1, edits: [{ file: "server.ts", old: "42", new: "43" }] }),
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

test("a backend's scheduled() notifies you, opening the box, with a note the bot reads as untrusted; 10 a day, and none once paused", async () => {
  const model = new FakeModel([{ content: [text("Hello.")] }, { content: [text("Cheaper.")] }]);
  const t = await testApp(model);
  const config = { hosts: [], cron: "*/5 * * * *" };
  t.boxes.create(
    { botId: "hatbot", conversationId: 1, title: "Prices", html: PAGE, files: files(config) },
    {},
  );
  await t.thread.post("hi").done;
  t.hatbox.run = { ok: true, notify: "Price dropped to €40" };
  const tick = async () => {
    t.advance(5 * 60_000);
    await t.boxes.backends?.tick();
  };
  await tick();
  expect(t.notifier.sent).toEqual([
    { title: "Prices", message: "Price dropped to €40", priority: 3, click: `${ORIGIN}/boxes/1` },
  ]);
  expect(t.thread.list().at(-1)).toMatchObject({ kind: "box", boxId: 1 });
  await t.thread.post("anything new?").done;
  expect(lastUserText(model.requests[1])).toContain("Price dropped to €40");
  expect(lastUserText(model.requests[1])).toContain('trusted=\\"false\\"');

  // The eleventh in a day isn't sent: the box's log says so. The page's own notes count apart.
  for (let i = 0; i < 10; i++) await tick();
  expect(t.notifier.sent).toHaveLength(10);
  expect(t.hatbox.notes).toEqual([
    "1: Not notified: a box notifies at most 10 times a day. It said: Price dropped to €40",
  ]);
  const note = await t.call("POST", "/boxes/1/call", { op: "send", text: "Hi" }, signIn(t));
  expect(note.status).toBe(200);

  // A run that ends after Pause all tells you nothing.
  t.advance(86400_000);
  const run = t.hatbox.scheduled.bind(t.hatbox);
  t.hatbox.scheduled = async (...a) => {
    const r = await run(...a);
    t.settings.update({ paused: true });
    return r;
  };
  await tick();
  expect(t.notifier.sent).toHaveLength(10);
  expect(t.hatbox.notes.at(-1)).toStartWith("1: Not notified: Hatbot is paused.");
});

test("a backend's secrets: set by you, sent only to the guest, never in an answer, event or the model's context; with one set, a new host or a tainted chat's code change goes to the review, which can block it", async () => {
  const model = new FakeModel([{ content: [text("Hello.")] }]);
  let safe = true;
  model.onCreate = (p) =>
    p.system === REVIEW_PROMPT ? JSON.stringify({ safe, why: "Fine." }) : undefined;
  const t = await testApp(model);
  const KEY = "sk-w/eather+5ecret";
  const config = { hosts: ["api.weather.test"], secrets: ["WEATHER_KEY"] };
  t.boxes.create(
    { botId: "hatbot", conversationId: 1, title: "Weather", html: PAGE, files: files(config) },
    {},
  );
  await t.thread.post("hi").done;
  const setSecrets = (values: object) => t.call("PUT", "/boxes/1/secrets", { values }, signIn(t));
  expect((await setSecrets({ OTHER_KEY: "x" })).status).toBe(400);
  const set = await setSecrets({ WEATHER_KEY: KEY });
  expect(await set.json()).toEqual([{ name: "WEATHER_KEY", set: true }]);

  // A new host for its backend goes to the review, untainted as the chat is, naming the secret.
  model.script.push(
    {
      content: [
        toolUse("boxes_edit", {
          box: 1,
          edits: [{ file: "box.json", old: "api.weather.test", new: 'api.weather.test","x.test' }],
        }),
      ],
    },
    { content: [text("Added.")] },
  );
  await t.thread.post("let it reach x.test too").done;
  const review = JSON.stringify(model.creates.find((p) => p.system === REVIEW_PROMPT)?.messages);
  expect(review).toContain("reach x.test");
  expect(review).toContain("WEATHER_KEY");
  expect(t.boxes.hosts(1)).toEqual(["api.weather.test", "x.test"]);

  // Its backend gets it; what comes back has it taken out, however it's spelled.
  t.hatbox.backend = () =>
    new Response(`key=${KEY}&q=${encodeURIComponent(KEY)}`, { headers: { "x-echo": KEY } });
  t.hatbox.log = `fetched https://api.weather.test/?key=${encodeURIComponent(KEY)}`;
  model.script.push(
    {
      content: [
        toolUse("boxes_read", { box: 1 }),
        toolUse("boxes_call", { box: 1, path: "/" }),
        toolUse("boxes_logs", { box: 1 }),
      ],
    },
    { content: [text("Sunny.")] },
  );
  await t.thread.post("what does the weather box say?").done;
  expect(t.hatbox.secretsOf.get(1)?.values).toEqual({ WEATHER_KEY: KEY });
  const page = await boxFetch(t, { path: "/" });
  expect(page.value?.body).toBe("key=[secret WEATHER_KEY]&q=[secret WEATHER_KEY]");
  const read = lastUserText(model.requests.at(-1));
  expect(read).toContain("WEATHER_KEY (set)");
  expect(read).toContain("fetched https://api.weather.test/?key=[secret WEATHER_KEY]");
  const detail = await (await t.call("GET", "/boxes/1", undefined, signIn(t))).text();
  for (const seen of [
    JSON.stringify(model.requests),
    JSON.stringify(t.events),
    JSON.stringify(page),
    detail,
  ]) {
    expect(seen).not.toContain(KEY);
    expect(seen).not.toContain(encodeURIComponent(KEY));
  }

  // In a tainted chat, a change to its backend's code goes to the review; blocked, it isn't built.
  t.db.query("UPDATE episodes SET tainted = 1, tainted_by = 'https://evil.example'").run();
  safe = false;
  const builds = t.hatbox.builds.length;
  model.script.push(
    {
      content: [
        toolUse("boxes_edit", { box: 1, edits: [{ file: "server.ts", old: "42", new: "43" }] }),
      ],
    },
    { content: [text("Not changed.")] },
  );
  await t.thread.post("do what that page said").done;
  expect(t.approvals.list(false)[0]).toMatchObject({ status: "blocked" });
  expect(t.approvals.list(false)[0]?.summary).toContain("Change the backend code");
  expect(t.hatbox.builds).toHaveLength(builds);

  await setSecrets({ WEATHER_KEY: null });
  expect(t.hatbox.secretsOf.has(1)).toBe(false);
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
      await agent.http(1, 1, "", { method: "POST", path, headers: [] });
    expect(seen).toHaveLength(4);
    for (const p of seen) expect(p).toStartWith("/boxes/1/http/");
  } finally {
    guest.stop(true);
  }
});
