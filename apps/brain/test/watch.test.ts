import { expect, test } from "bun:test";
import { counts, numberIn } from "@hatbot/plugin-automation";
import { type Task, type Watcher, WatchSourceInput } from "@hatbot/shared";
import { FakeModel, text, toolUse } from "./fake-model";
import { signIn, type TestApp, testApp, waitFor } from "./helpers";

const page = (body: string) =>
  `<!doctype html><html><head><title>Shop</title><style>p{}</style></head><body>${body}<script>var x = 1;</script></body></html>`;

async function owner(t: TestApp) {
  const { cookie } = signIn(t);
  return (method: string, path: string, body?: unknown) => t.call(method, path, body, { cookie });
}

test("a page's address must be http or https", () => {
  expect(WatchSourceInput.safeParse({ kind: "page", url: "file:///etc/passwd" }).success).toBe(
    false,
  );
  expect(WatchSourceInput.safeParse({ kind: "page", url: "http://shop.example/" }).success).toBe(
    true,
  );
});

test("a percentage is the number when there's no other, and a badge doesn't beat the price", () => {
  expect(numberIn("15%")).toBe(15);
  expect(numberIn("Battery: 15 %, -20% 7")).toBe(7);
  expect(numberIn("-20% 1 299 zł")).toBe(1299);
  expect(counts({ when: "below", value: 20 }, "25%", "15%")).toBe(true);
});

test("a watcher without a prompt tells you in its thread and by notification, then waits", async () => {
  const t = await testApp();
  const api = await owner(t);
  const url = "https://shop.example/fw16";
  t.agent.pages.set(url, page(`<span id="stock">Sold out</span>`));

  const res = await api("POST", "/watchers", {
    name: "Framework 16",
    source: { kind: "page", url, selector: "#stock" },
    condition: { when: "contains", text: "in stock" },
    everyMinutes: 30,
  });
  expect(res.status).toBe(201);
  const w = (await res.json()) as Watcher;
  expect(w.lastValue).toBe("Sold out");

  t.watchers.tick();
  await t.watchers.idle();
  expect(t.agent.fetched).toHaveLength(1);

  t.agent.pages.set(url, page(`<span id="stock">In stock</span>`));
  t.advance(30 * 60_000);
  t.watchers.tick();
  await t.watchers.idle();
  expect(t.agent.fetched).toHaveLength(2);
  const [thread] = t.chats.threads(1);
  expect(t.notifier.sent.map((n) => [n.title, n.click])).toEqual([
    ["Framework 16", `https://hatbot.test/chat/1?thread=${thread?.id}`],
  ]);
  expect(
    t.chats
      .thread(thread?.id as number)
      ?.list()
      .at(-1)?.text,
  ).toContain("In stock");
  // The model isn't called for any of it.
  expect(t.taskModel.requests).toHaveLength(0);

  t.advance(30 * 60_000);
  t.watchers.tick();
  await t.watchers.idle();
  expect(t.notifier.sent).toHaveLength(1);
});

test("a watcher with a prompt starts its bot's task with the change, untrusted", async () => {
  const work = new FakeModel([
    {
      content: [
        toolUse("finish_task", {
          outcome: "done",
          summary: "Ordered nothing; told you.",
          notify: true,
        }),
      ],
    },
  ]);
  const t = await testApp(new FakeModel(), work);
  const url = "https://shop.example/price.json";
  t.agent.pages.set(url, '{"price": 1299}');
  const w = await t.watchers.create(
    {
      name: "FW16 price",
      source: { kind: "page", url, path: "price" },
      condition: { when: "below", value: 1000 },
      prompt: "Tell me if it's a good deal.",
      everyMinutes: 60,
      once: true,
      enabled: true,
      botId: "hatbot",
    },
    "owner",
  );
  t.agent.pages.set(url, '{"price": 949}');
  const after = await t.watchers.checkNow(w.id);
  // Once: it switches off after it counts.
  expect(after).toMatchObject({ enabled: false, nextCheckAt: null, lastValue: "949" });
  const [task] = t.tasks.list() as [Task];
  expect(task).toMatchObject({ origin: "watch", watcherId: w.id, source: "FW16 price" });
  await waitFor(() => t.tasks.get(task.id)?.finishedAt);
  // A web page is untrusted, so the change arrives marked as such.
  const sent = JSON.stringify(work.requests[0]?.messages);
  expect(sent).toContain("949");
  expect(sent).toContain('trusted=\\"false\\"');
});

test("a watcher that counts more than 12 times in a day is switched off, and you're told once", async () => {
  const t = await testApp();
  const api = await owner(t);
  const url = "https://news.example/";
  t.agent.pages.set(url, page(`<p>Updated 0 minutes ago</p>`));
  const w = (await (
    await api("POST", "/watchers", { name: "News", source: { kind: "page", url }, everyMinutes: 5 })
  ).json()) as Watcher;
  for (let i = 1; i <= 14; i++) {
    t.agent.pages.set(url, page(`<p>Updated ${i * 5} minutes ago</p>`));
    t.advance(5 * 60_000);
    t.watchers.tick();
    await t.watchers.idle();
  }
  expect(t.watchers.get(w.id)).toMatchObject({ enabled: false, nextCheckAt: null });
  const titles = t.notifier.sent.map((n) => n.title);
  expect(titles.filter((x) => x === "News")).toHaveLength(12);
  expect(titles.filter((x) => x !== "News")).toHaveLength(1);
});

test("a check of the old source that fails after a new one is saved doesn't count against it", async () => {
  const t = await testApp();
  const api = await owner(t);
  const old = "https://shop.example/old";
  const fresh = "https://shop.example/fresh";
  t.agent.pages.set(old, page(`<p class="price">€10</p>`));
  t.agent.pages.set(fresh, page(`<p class="price">€8</p>`));
  const w = (await (
    await api("POST", "/watchers", {
      name: "W",
      source: { kind: "page", url: old, selector: ".price" },
      everyMinutes: 5,
    })
  ).json()) as Watcher;
  // While the old page is read, and found moved, the owner points the watcher at another one.
  t.agent.pages.set(old, page(`<p>moved</p>`));
  const fetch = t.agent.fetch.bind(t.agent);
  t.agent.fetch = async (u) => {
    if (u === old)
      await t.watchers.update(w.id, { source: { kind: "page", url: fresh, selector: ".price" } });
    return fetch(u);
  };
  t.advance(5 * 60_000);
  t.watchers.tick();
  await t.watchers.idle();
  expect(t.watchers.get(w.id)).toMatchObject({ errors: 0, lastError: null, lastValue: "€8" });
});

test("a watcher the chat made after reading something untrusted is tainted until you save it", async () => {
  const chat = new FakeModel([
    { content: [text("hi")] },
    {
      content: [
        toolUse("automation_watch_create", {
          name: "Up",
          url: "https://example.com/s",
          prompt: "Restart it",
        }),
      ],
    },
    { content: [text("Watching.")] },
  ]);
  const t = await testApp(chat);
  const api = await owner(t);
  t.agent.pages.set("https://example.com/s", page("<p>ok</p>"));
  await t.thread.post("hello").done;
  t.db.query("UPDATE episodes SET tainted = 1, tainted_by = 'https://example.com'").run();
  await t.thread.post("watch it").done;
  const [w] = t.watchers.list() as [Watcher];
  expect(w).toMatchObject({ tainted: true, taintedBy: "https://example.com" });
  // Trust clears the mark, and so does saving what it does.
  const trusted = (await (await api("POST", `/watchers/${w.id}/trust`)).json()) as Watcher;
  expect(trusted.tainted).toBe(false);
  t.db.query("UPDATE watchers SET tainted = 1").run();
  const saved = (await (
    await api("PATCH", `/watchers/${w.id}`, { prompt: "Restart it" })
  ).json()) as Watcher;
  expect(saved.tainted).toBe(false);
});
