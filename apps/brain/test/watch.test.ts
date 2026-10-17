import { expect, test } from "bun:test";
import { type Task, type Watcher, type WatcherValue, WatchSourceInput } from "@hatbot/shared";
import { REVIEW_PROMPT } from "../src/agent/prompt";
import { counts, numberIn, pick } from "../src/watch/extract";
import { FakeModel, text, toolUse } from "./fake-model";
import { setUpOwner, type TestApp, testApp, waitFor } from "./helpers";

const page = (body: string) =>
  `<!doctype html><html><head><title>Shop</title><style>p{}</style></head><body>${body}<script>var x = 1;</script></body></html>`;

async function owner(t: TestApp) {
  const { cookie } = await setUpOwner(t);
  return (method: string, path: string, body?: unknown) => t.call(method, path, body, { cookie });
}

test("values are picked by selector, path, pattern, or the page's text", async () => {
  const html = page(
    `<div class="price">€1.299,<b>00</b></div><div class="price">€99</div><p>In&nbsp;stock &amp; ready</p><img class="price">`,
  );
  expect(await pick(html, "text/html", { kind: "page", selector: ".price" })).toBe(
    "€1.299,00\n€99",
  );
  expect(await pick(html, "text/html", { kind: "page" })).toBe("€1.299, 00 €99 In stock & ready");
  expect(await pick(html, "text/html", { kind: "page", pattern: "in\\s+(stock)" })).toBe("stock");
  expect(
    await pick('{"items":[{"price":12.5}]}', "application/json", {
      kind: "page",
      path: "items.0.price",
    }),
  ).toBe("12.5");
  await expect(pick(html, "text/html", { kind: "page", selector: ".gone" })).rejects.toThrow(
    "matched nothing",
  );
  await expect(pick(html, "text/html", { kind: "page", path: "a" })).rejects.toThrow("isn't JSON");
  await expect(pick(html, "text/html", { kind: "page", pattern: "(" })).rejects.toThrow(
    "isn't a regular expression",
  );
});

test("a page without a full address says what to write", () => {
  const r = WatchSourceInput.safeParse({ kind: "page", url: "example.com/shop" });
  expect(r.success).toBe(false);
  expect(r.error?.issues[0]?.message).toBe("Use a full address starting with https://");
});

test("a pattern that backtracks without end is stopped, and the brain keeps answering", async () => {
  // Catastrophic backtracking: on the main thread this would take far longer than the test.
  const body = `${"a".repeat(40)}!`;
  let ticks = 0;
  const timer = setInterval(() => ticks++, 10);
  const started = performance.now();
  try {
    await expect(
      pick(body, "text/plain", { kind: "page", pattern: "^(a+)+$" }, 300),
    ).rejects.toThrow('The pattern "^(a+)+$" took too long');
  } finally {
    clearInterval(timer);
  }
  expect(performance.now() - started).toBeLessThan(3000);
  expect(ticks).toBeGreaterThan(5);
  // A plain one still answers, and sees only the first 200,000 characters.
  const long = `${"x".repeat(200_000)}price 42`;
  await expect(pick(long, "text/plain", { kind: "page", pattern: "price (\\d+)" })).rejects.toThrow(
    "matched nothing",
  );
  expect(await pick("price 42", "text/plain", { kind: "page", pattern: "price (\\d+)" })).toBe(
    "42",
  );
});

test("numbers are read in either style, and only a move into the condition counts", () => {
  expect(numberIn("€1.299,00")).toBe(1299);
  expect(numberIn("$1,299.00")).toBe(1299);
  expect(numberIn("1,299")).toBe(1299);
  expect(numberIn("12,5 °C")).toBe(12.5);
  expect(numberIn("-3.5")).toBe(-3.5);
  expect(numberIn("none")).toBeNaN();
  // Polish prices.
  expect(numberIn("1 299,99 zł")).toBe(1299.99);
  expect(numberIn("1\u00a0299,99\u00a0zł")).toBe(1299.99);
  expect(numberIn("1.299 zł")).toBe(1299);
  expect(numberIn("1 299 zł")).toBe(1299);
  expect(numberIn("Cena: 12 499,00 PLN")).toBe(12499);
  expect(numberIn("2 599 złotych")).toBe(2599);
  expect(numberIn("0,99 zł")).toBe(0.99);
  // A badge or a model number before the price doesn't win.
  expect(numberIn("-20% 1 299 zł")).toBe(1299);
  expect(numberIn("-300 zł 1 299 zł")).toBe(1299);
  expect(numberIn("Rabat -300 zł\n1 299 zł")).toBe(1299);
  expect(numberIn("-300 zł")).toBe(-300);
  expect(numberIn("Taniej o 15 % 849,00 zł")).toBe(849);
  expect(numberIn("Laptop 16 GB 3 999 zł")).toBe(3999);
  // A percentage is the number when there's no other.
  expect(numberIn("15%")).toBe(15);
  expect(numberIn("Battery: 15 %, -20% 7")).toBe(7);
  expect(counts({ when: "below", value: 20 }, "25%", "15%")).toBe(true);
  // Neighbouring prices aren't read as one number.
  expect(numberIn("1 299 zł 1 499 zł")).toBe(1299);
  expect(numberIn("299\n999")).toBe(299);
  // Without a currency a lone dot is still a decimal point, and a dash after a word isn't a minus.
  expect(numberIn("1.299")).toBe(1.299);
  expect(numberIn("−3,5 °C")).toBe(-3.5);
  expect(numberIn("A-4 paper, 500 sheets")).toBe(4);

  const below = { when: "below", value: 1000 } as const;
  expect(counts(below, null, "€999")).toBe(true);
  expect(counts(below, "€1.099,00", "€999")).toBe(true);
  expect(counts(below, "€999", "€989")).toBe(false);
  expect(counts(below, "€999", "€1.099,00")).toBe(false);
  const stock = { when: "contains", text: "in stock" } as const;
  expect(counts(stock, "Sold out", "In stock")).toBe(true);
  expect(counts(stock, null, "Sold out")).toBe(false);
  expect(counts({ when: "changed" }, null, "a")).toBe(false);
  expect(counts({ when: "changed" }, "a", "b")).toBe(true);
  expect(counts({ when: "changed" }, "a", "a")).toBe(false);
  // Only the spacing between elements: not a change.
  expect(counts({ when: "changed" }, "€10 €12", "€10\n€12")).toBe(false);
});

test("each price a selector matches is read on its own", async () => {
  const html = page(
    `<span class="badge">-20%</span><span class="price">299</span><span class="price">999</span>`,
  );
  const value = await pick(html, "text/html", { kind: "page", selector: ".price" });
  expect(value).toBe("299\n999");
  expect(numberIn(value)).toBe(299);
  const shop = await pick(
    page(`<div class="product"><span>-20%</span> <b>1 299,99 zł</b> <s>1 624,99 zł</s></div>`),
    "text/html",
    { kind: "page", selector: ".product" },
  );
  expect(numberIn(shop)).toBe(1299.99);
  expect(counts({ when: "below", value: 1300 }, "1 499,99 zł", shop)).toBe(true);
});

test("a watcher without a prompt tells you in the chat and by notification, then waits", async () => {
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
  expect(w).toMatchObject({ lastValue: "Sold out", createdVia: "owner", tainted: false });
  expect(t.notifier.sent).toHaveLength(0);

  // Not due yet.
  t.watchers.tick();
  await t.watchers.idle();
  expect(t.agent.fetched).toHaveLength(1);

  t.agent.pages.set(url, page(`<span id="stock">In stock</span>`));
  t.advance(30 * 60_000);
  t.watchers.tick();
  await t.watchers.idle();
  expect(t.agent.fetched).toHaveLength(2);
  expect(t.notifier.sent.at(-1)).toMatchObject({
    title: "Framework 16",
    message: "Sold out → In stock",
    click: `https://hatbot.test/watchers/${w.id}`,
  });
  expect(t.thread.list().at(-1)?.text).toBe("**Framework 16**: Sold out → In stock");
  // The model isn't called for any of it.
  expect(t.taskModel.requests).toHaveLength(0);
  expect(t.tasks.list()).toHaveLength(0);

  // Still in stock: no second notification.
  t.advance(30 * 60_000);
  t.watchers.tick();
  await t.watchers.idle();
  expect(t.notifier.sent).toHaveLength(1);
  const values = (await (await api("GET", `/watchers/${w.id}/values`)).json()) as WatcherValue[];
  expect(values.map((v) => [v.value, v.fired])).toEqual([
    ["In stock", true],
    ["Sold out", false],
  ]);
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
  const sent = JSON.stringify(work.requests[0]?.messages);
  expect(sent).toContain("Was: 1299");
  expect(sent).toContain("Now: 949");
  // A web page is untrusted, so the change arrives marked as such.
  expect(sent).toContain('trusted=\\"false\\"');
  const tasks = (await (
    await t.call("GET", `/tasks?watcherId=${w.id}`, undefined, {
      cookie: (await setUpOwner(t)).cookie,
    })
  ).json()) as Task[];
  expect(tasks.map((x) => x.id)).toEqual([task.id]);
});

test("a page that can't be read isn't made, and failing checks are told once", async () => {
  const t = await testApp();
  const api = await owner(t);
  const url = "https://shop.example/x";
  const bad = await api("POST", "/watchers", {
    name: "X",
    source: { kind: "page", url, selector: ".price" },
  });
  expect(bad.status).toBe(400);
  expect(((await bad.json()) as { error: string }).error).toContain("no such page");

  t.agent.pages.set(url, page(`<p class="price">5</p>`));
  const preview = await (
    await api("POST", "/watchers/preview", {
      source: { kind: "page", url, selector: ".price" },
    })
  ).json();
  expect(preview).toEqual({ ok: true, value: "5" });
  const w = (await (
    await api("POST", "/watchers", {
      name: "X",
      source: { kind: "page", url, selector: ".price" },
      everyMinutes: 5,
    })
  ).json()) as Watcher;
  t.agent.pages.set(url, page(`<p>moved</p>`));
  // From the third failure in a row, each wait is twice the last.
  const waits: number[] = [];
  const gap = () => {
    const x = t.watchers.get(w.id);
    return Date.parse(x?.nextCheckAt ?? "") - Date.parse(x?.lastCheckedAt ?? "");
  };
  for (let i = 0; i < 6; i++) {
    t.advance(gap());
    t.watchers.tick();
    await t.watchers.idle();
    waits.push(gap() / 60_000);
  }
  expect(waits).toEqual([5, 5, 10, 20, 40, 80]);
  expect(t.watchers.get(w.id)).toMatchObject({ errors: 6, lastValue: "5" });
  expect(t.watchers.get(w.id)?.lastError).toContain("matched nothing");
  expect(t.notifier.sent.map((n) => n.title)).toEqual(["Can't check X"]);
  const checks = (await (await api("POST", "/checks")).json()) as {
    results: { id: string; state: string }[];
  };
  expect(checks.results.find((c) => c.id === "watchers")?.state).toBe("warn");

  expect((await api("DELETE", `/watchers/${w.id}`)).status).toBe(200);
  expect(t.watchers.list()).toHaveLength(0);
});

test("a watcher that counts more than 12 times in a day is switched off, and you're told once", async () => {
  const t = await testApp();
  const api = await owner(t);
  const url = "https://news.example/";
  t.agent.pages.set(url, page(`<p>Updated 0 minutes ago</p>`));
  const w = (await (
    await api("POST", "/watchers", { name: "News", source: { kind: "page", url }, everyMinutes: 5 })
  ).json()) as Watcher;
  // A page that changes on every look.
  for (let i = 1; i <= 14; i++) {
    t.agent.pages.set(url, page(`<p>Updated ${i * 5} minutes ago</p>`));
    t.advance(5 * 60_000);
    t.watchers.tick();
    await t.watchers.idle();
  }
  const off = t.watchers.get(w.id);
  expect(off).toMatchObject({
    enabled: false,
    nextCheckAt: null,
    lastValue: "Updated 65 minutes ago",
  });
  expect(off?.lastError).toContain("more than 12 times in a day");
  const titles = () => t.notifier.sent.map((n) => n.title);
  expect(titles().filter((x) => x === "News")).toHaveLength(12);
  expect(titles().filter((x) => x === "News is off")).toHaveLength(1);
  // Only 13 looks: the 14th found it off.
  expect(t.agent.fetched).toHaveLength(14);

  // Switched back on, it counts from then.
  expect((await api("PATCH", `/watchers/${w.id}`, { enabled: true })).status).toBe(200);
  expect(t.watchers.get(w.id)?.lastError).toBeNull();
  t.agent.pages.set(url, page(`<p>Updated 70 minutes ago</p>`));
  t.watchers.tick();
  await t.watchers.idle();
  expect(t.watchers.get(w.id)?.enabled).toBe(true);
  expect(titles().filter((x) => x === "News")).toHaveLength(13);
});

test("a watcher deleted while its page is read is let go, and the checks carry on", async () => {
  const t = await testApp();
  const api = await owner(t);
  const url = "https://shop.example/gone";
  t.agent.pages.set(url, page(`<p class="price">€10</p>`));
  const make = async (name: string) =>
    (await (
      await api("POST", "/watchers", {
        name,
        source: { kind: "page", url, selector: ".price" },
        everyMinutes: 5,
      })
    ).json()) as Watcher;
  const a = await make("A");
  const b = await make("B");
  // The owner deletes A while the desktop reads its page, the first time with a new value, then
  // while a read fails.
  const fetch = t.agent.fetch.bind(t.agent);
  t.agent.fetch = async (u) => {
    const r = await fetch(u);
    t.watchers.delete(a.id);
    return r;
  };
  t.agent.pages.set(url, page(`<p class="price">€9</p>`));
  t.advance(5 * 60_000);
  const logged: unknown[][] = [];
  const log = console.error;
  console.error = (...args: unknown[]) => logged.push(args);
  try {
    t.watchers.tick();
    await t.watchers.idle();
  } finally {
    console.error = log;
  }
  expect(logged).toEqual([]);
  expect(t.watchers.get(a.id)).toBeNull();
  expect(
    t.db.query("SELECT count(*) AS n FROM watcher_values WHERE watcher_id = ?").get(a.id),
  ).toEqual({ n: 0 });
  // The other one carried on.
  expect(t.watchers.get(b.id)?.lastValue).toBe("€9");

  const c = await make("C");
  t.agent.fetch = async (u) => {
    t.watchers.delete(c.id);
    return fetch(u);
  };
  t.agent.pages.set(url, page(`<p>moved</p>`));
  for (let i = 0; i < 6; i++) {
    t.advance(60 * 60_000);
    t.watchers.tick();
    await t.watchers.idle();
  }
  expect(t.watchers.get(c.id)).toBeNull();
  expect(t.notifier.sent.map((n) => n.title)).not.toContain("Can't check C");

  // Deleted while a new source is read for it: it's gone, not an error.
  t.agent.fetch = fetch;
  t.agent.pages.set(url, page(`<p class="price">€9</p>`));
  const d = await make("D");
  expect(d.id).toBeNumber();
  t.agent.pages.set("https://shop.example/new", page(`<p class="price">€8</p>`));
  t.agent.fetch = async (u) => {
    const r = await fetch(u);
    t.watchers.delete(d.id);
    return r;
  };
  const moved = await api("PATCH", `/watchers/${d.id}`, {
    source: { kind: "page", url: "https://shop.example/new", selector: ".price" },
  });
  expect(moved.status).toBe(404);
});

test("the chat makes a watcher from what it saw first", async () => {
  const chat = new FakeModel([
    {
      content: [
        toolUse("watch_create", {
          name: "Release",
          url: "https://example.com/releases",
          pattern: "v(\\d+\\.\\d+)",
          when: "changed",
          every_minutes: 1,
        }),
      ],
    },
    { content: [text("Watching it.")] },
  ]);
  const t = await testApp(chat);
  t.agent.pages.set("https://example.com/releases", page("<h1>Latest v2.3</h1>"));
  t.thread.post("tell me when there's a new release");
  await t.thread.idle();
  const [w] = t.watchers.list() as [Watcher];
  expect(w).toMatchObject({
    createdVia: "chat",
    lastValue: "2.3",
    everyMinutes: 5,
    tainted: false,
  });
  const result = JSON.stringify(chat.requests[1]?.messages.at(-1));
  expect(result).toContain("Created watcher #");
  // What a page said is quoted, as data.
  expect(JSON.parse(result).content[0].content).toContain(
    'Now: <value trusted="false">"2.3"</value>',
  );
});

test("watch_update changes only the picks it's given", async () => {
  const chat = new FakeModel([
    { content: [toolUse("watch_update", { id: 1, pattern: "v(\\d+)" })] },
    { content: [text("Done.")] },
  ]);
  const t = await testApp(chat);
  const url = "https://example.com/r";
  t.agent.pages.set(url, page(`<h1 class="v">Latest v2.3</h1>`));
  await t.watchers.create(
    {
      name: "R",
      source: { kind: "page", url, selector: ".v" },
      condition: { when: "changed" },
      prompt: "",
      everyMinutes: 60,
      once: false,
      enabled: true,
      botId: "hatbot",
    },
    "owner",
  );
  t.thread.post("only the major version");
  await t.thread.idle();
  expect(t.watchers.get(1)?.source).toEqual({
    kind: "page",
    url,
    selector: ".v",
    pattern: "v(\\d+)",
  });
  expect(t.watchers.get(1)?.lastValue).toBe("2");
});

test("a watcher the chat made after reading something untrusted is tainted until you save it", async () => {
  const chat = new FakeModel([
    { content: [text("hi")] },
    {
      content: [
        toolUse("watch_create", {
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
  const saved = (await (
    await api("PATCH", `/watchers/${w.id}`, { prompt: "Restart it" })
  ).json()) as Watcher;
  expect(saved.tainted).toBe(false);
});

test("a page that fills in with its scripts is read once they ran, every 15 minutes at most", async () => {
  const t = await testApp();
  const api = await owner(t);
  const url = "https://shop.example/app";
  t.agent.pages.set(url, page(`<p id="price">Loading…</p>`));
  t.agent.rendered.set(url, page(`<p id="price">€999</p>`));
  const source = { kind: "page", url, selector: "#price", render: true };

  expect(await (await api("POST", "/watchers/preview", { source })).json()).toEqual({
    ok: true,
    value: "€999",
  });
  const often = await api("POST", "/watchers", { name: "App", source, everyMinutes: 5 });
  expect(often.status).toBe(400);
  expect(((await often.json()) as { error: string }).error).toBe(
    "A watcher can't look more often than every 15 minutes when it runs the page's scripts.",
  );
  const json = await api("POST", "/watchers", {
    name: "App",
    source: { kind: "page", url, path: "price", render: true },
    everyMinutes: 15,
  });
  expect(((await json.json()) as { error: string }).error).toContain("JSON path");

  const w = (await (
    await api("POST", "/watchers", { name: "App", source, everyMinutes: 15 })
  ).json()) as Watcher;
  expect(w).toMatchObject({ lastValue: "€999", source: { render: true } });
  expect(t.agent.fetched).toHaveLength(0);
  t.agent.rendered.set(url, page(`<p id="price">€949</p>`));
  t.advance(15 * 60_000);
  t.watchers.tick();
  await t.watchers.idle();
  expect(t.watchers.get(w.id)?.lastValue).toBe("€949");
  expect(t.agent.renders).toEqual([url, url, url]);

  // Off again: a plain fetch, which has only what the page is sent with. An off switch isn't kept.
  const off = (await (
    await api("PATCH", `/watchers/${w.id}`, { source: { ...source, render: false } })
  ).json()) as Watcher;
  expect(off.source).toEqual({ kind: "page", url, selector: "#price" });
  expect(off.lastValue).toBe("Loading…");
  expect(t.agent.fetched).toEqual([url]);
});

test("the chat turns a page's scripts on and off, and the interval follows", async () => {
  const chat = new FakeModel([
    {
      content: [
        toolUse("watch_create", {
          name: "App",
          url: "https://example.com/app",
          selector: "#v",
          render: true,
          every_minutes: 5,
        }),
      ],
    },
    { content: [text("Watching.")] },
    { content: [toolUse("watch_update", { id: 1, render: false, every_minutes: 5 })] },
    { content: [text("Done.")] },
    { content: [toolUse("watch_update", { id: 1, render: true })] },
    { content: [text("Done.")] },
  ]);
  // What it saw on the page taints the chat: Haiku's review lets the owner's changes through.
  chat.onCreate = (p) =>
    p.system === REVIEW_PROMPT ? JSON.stringify({ safe: true, why: "Asked for." }) : undefined;
  const t = await testApp(chat);
  const url = "https://example.com/app";
  t.agent.pages.set(url, page(`<p id="v">…</p>`));
  t.agent.rendered.set(url, page(`<p id="v">v2.4</p>`));
  await t.thread.post("watch the app's version").done;
  expect(t.watchers.get(1)).toMatchObject({
    source: { kind: "page", url, selector: "#v", render: true },
    everyMinutes: 15,
    lastValue: "v2.4",
  });
  expect(JSON.stringify(chat.requests[1]?.messages.at(-1))).toContain("runs its scripts");

  await t.thread.post("no need for the scripts, and look more often").done;
  expect(t.watchers.get(1)?.source).toEqual({ kind: "page", url, selector: "#v" });
  expect(t.watchers.get(1)).toMatchObject({ everyMinutes: 5, lastValue: "…" });

  await t.thread.post("run them again").done;
  expect(t.watchers.get(1)).toMatchObject({ source: { render: true }, everyMinutes: 15 });
});
