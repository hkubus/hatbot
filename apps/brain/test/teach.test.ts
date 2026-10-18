import { expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { TeachSession } from "@hatbot/shared";
import type { LiveInput } from "@hatbot/shared/desktop";
import { websocket } from "hono/bun";
import { TEACH_PROMPT } from "../src/agent/prompt";
import type { EventBus } from "../src/events";
import { HATBOT } from "../src/memory/store";
import { describeSteps, type FieldCheck, OffPage, Recorder } from "../src/teach/recorder";
import { Teach } from "../src/teach/service";
import { describeSkill, withSkillsSection } from "../src/teach/skills";
import { FakeModel, text, toolUse } from "./fake-model";
import { ORIGIN, setUpOwner, type TestApp, testApp, waitFor } from "./helpers";

const SKILL = `---
name: renew-library-books
description: Renew borrowed books on the city library site.
---
# Renew library books

## When to use
When books are due.

## Steps
1. Open https://library.example/account and log in with request_takeover.
2. Click Renew all.`;

const typeText = (s: string): LiveInput[] =>
  [...s].flatMap((key) => [
    { t: "key", key, down: true },
    { t: "key", key, down: false },
  ]);
const press = (key: string): LiveInput[] => [
  { t: "key", key, down: true },
  { t: "key", key, down: false },
];
const click = (x: number, y: number): LiveInput[] => [
  { t: "move", x: x - 40, y: y - 10 },
  { t: "move", x, y },
  { t: "button", button: 1, down: true, x, y },
  { t: "button", button: 1, down: false, x, y },
];

/** A field check's answer, or a screenshot, with or without the address it was on. */
function recorder(
  secret: () => Promise<boolean | FieldCheck> = async () => false,
  screen: () => Promise<Uint8Array | { bytes: Uint8Array; url: string } | null> = async () =>
    new Uint8Array([1]),
) {
  let now = 0;
  let shots = 0;
  const saved: string[] = [];
  const r = new Recorder({
    clock: () => now,
    secretField: async () => {
      const s = await secret();
      return typeof s === "boolean" ? { secret: s } : s;
    },
    screen: async () => {
      const s = await screen();
      return s instanceof Uint8Array ? { bytes: s } : s;
    },
    save: async (label) => {
      saved.push(label);
      return `screens/teach/${++shots}-${label}.webp`;
    },
  });
  return { r, saved, tick: (ms: number) => (now += ms) };
}

const keys = (r: Recorder, ...ms: [string, boolean][]) => {
  for (const [key, down] of ms) r.input({ t: "key", key, down });
};

test("the recorder merges moves and scrolls, edits typing, and keeps shortcuts", async () => {
  const { r, tick } = recorder();
  r.page("https://library.example/", "Library");
  for (const m of click(400, 300)) r.input(m);
  tick(500);
  for (const m of typeText("dune")) r.input(m);
  for (const m of press("Backspace")) r.input(m);
  for (const m of typeText("e")) r.input(m);
  for (const m of press("Enter")) r.input(m);
  r.input({ t: "wheel", dx: 0, dy: 100, x: 600, y: 400 });
  r.input({ t: "wheel", dx: 0, dy: 150, x: 600, y: 400 });
  r.input({ t: "key", key: "Control", down: true });
  for (const m of press("l")) r.input(m);
  r.input({ t: "key", key: "Control", down: false });
  r.page("https://library.example/search?q=dune", "Search");

  const steps = await r.finish();
  expect(steps.map((s) => s.kind)).toEqual([
    "page",
    "move",
    "button",
    "button",
    "text",
    "key",
    "wheel",
    "key",
    "page",
  ]);
  expect(steps[1]).toMatchObject({ x: 400, y: 300 });
  expect(steps[2]).toMatchObject({ down: true, screen: "screens/teach/1-3-click.webp" });
  expect(steps[4]).toMatchObject({ text: "dune", chars: 4, t: 500 });
  expect(steps[5]).toMatchObject({ key: "Enter", screen: "screens/teach/2-6-enter.webp" });
  expect(steps[6]).toMatchObject({ dy: 250 });
  expect(steps[7]).toMatchObject({ key: "ctrl+l" });

  const { lines, screens } = describeSteps(steps);
  expect(lines).toEqual([
    '[0.0s] page: "Library" https://library.example/',
    "[0.0s] left click at (400, 300) [screenshot 1]",
    '[0.5s] typed "dune"',
    "[0.5s] key Enter [screenshot 2]",
    "[0.5s] scroll down at (600, 400)",
    "[0.5s] key ctrl+l",
    '[0.5s] page: "Search" https://library.example/search?q=dune',
  ]);
  expect(screens).toHaveLength(2);
});

test("typing into a secret field, or one that can't be checked, isn't kept", async () => {
  const answers = [true, false, "fail"] as const;
  let n = 0;
  const { r } = recorder(async () => {
    const a = answers[n++];
    if (a === "fail") throw new Error("no focused element");
    return a === true;
  });
  for (const m of typeText("hunter22")) r.input(m);
  for (const m of press("Tab")) r.input(m);
  for (const m of typeText("visible")) r.input(m);
  for (const m of click(10, 10)) r.input(m);
  for (const m of typeText("unseen")) r.input(m);
  const steps = await r.finish();
  const typed = steps.filter((s) => s.kind === "text");
  expect(typed).toEqual([
    { t: 0, kind: "text", text: "", hidden: "secret", chars: 8 },
    { t: 0, kind: "text", text: "visible", chars: 7 },
    { t: 0, kind: "text", text: "", hidden: "unknown", chars: 6 },
  ]);
  expect(JSON.stringify(steps)).not.toContain("hunter");
  expect(JSON.stringify(steps)).not.toContain("unseen");
  expect(describeSteps(steps).lines.join("\n")).toContain(
    "typed 8 characters into a password or code field (not recorded)",
  );
});

test("AltGr and Option type characters, hidden with their field; Alt with a letter is a shortcut", async () => {
  const { r } = recorder(async () => true);
  // Linux: AltGr arrives as AltGraph.
  r.input({ t: "key", key: "AltGraph", down: true });
  for (const m of typeText("ąę")) r.input(m);
  r.input({ t: "key", key: "AltGraph", down: false });
  // Windows: AltGr is Ctrl and Alt together, with or without AltGraph.
  keys(r, ["Control", true], ["Alt", true]);
  for (const m of typeText("łś")) r.input(m);
  keys(r, ["Alt", false], ["Control", false]);
  keys(r, ["Control", true], ["AltGraph", true]);
  for (const m of typeText("ó")) r.input(m);
  keys(r, ["AltGraph", false], ["Control", false]);
  // A Mac's Option gives the character itself; a dead key only shapes the next one.
  keys(r, ["Alt", true]);
  for (const m of typeText("ż")) r.input(m);
  keys(r, ["Dead", true], ["Alt", false]);
  for (const m of typeText("x1")) r.input(m);
  const steps = await r.finish();
  expect(steps).toEqual([{ t: 0, kind: "text", text: "", hidden: "secret", chars: 8 }]);
  expect(JSON.stringify(steps)).not.toMatch(/[ąęłśóż]/);

  const plain = recorder();
  keys(plain.r, ["Alt", true], ["f", true], ["f", false], ["Alt", false]);
  expect(await plain.r.finish()).toEqual([{ t: 0, kind: "key", key: "alt+f" }]);
});

test("a stuck modifier doesn't leave a password in clear", async () => {
  // Ctrl went down, and its up never came: every key is ctrl+something.
  const { r } = recorder(async () => true);
  keys(r, ["Control", true]);
  for (const m of typeText("hunter2")) r.input(m);
  const steps = await r.finish();
  expect(steps).toHaveLength(7);
  expect(steps.every((s) => s.kind === "key" && s.key === "" && s.hidden === "secret")).toBe(true);
  expect(JSON.stringify(steps)).not.toContain("hunter");
  expect(describeSteps(steps).lines[0]).toBe(
    "[0.0s] pressed a key with a modifier in a password or code field (not recorded)",
  );

  // Outside the page (the address bar), a shortcut is kept; a run of them is typing with a stuck
  // modifier (in Chromium's own sign-in prompt, say), and isn't.
  const outside = recorder(async () => {
    throw new OffPage("the keyboard isn't on a page");
  });
  keys(outside.r, ["Control", true], ["l", true], ["l", false], ["Control", false]);
  expect(await outside.r.finish()).toEqual([{ t: 0, kind: "key", key: "ctrl+l" }]);
  const prompt = recorder(async () => {
    throw new OffPage("the keyboard isn't on a page");
  });
  keys(prompt.r, ["Control", true]);
  for (const m of typeText("hunter2")) prompt.r.input(m);
  const typedThere = await prompt.r.finish();
  expect(typedThere.map((s) => s.kind === "key" && s.key)).toEqual(["", "", "", "", "", "", ""]);
  expect(JSON.stringify(typedThere)).not.toContain("ctrl+");
  // The same when the check answers after the first key: the run is decided again as it grows.
  let answer = (_: unknown) => {};
  const late = recorder(
    () =>
      new Promise((_, reject) => {
        answer = reject;
      }),
  );
  keys(late.r, ["Control", true], ["h", true]);
  answer(new OffPage("the keyboard isn't on a page"));
  await Bun.sleep(0);
  for (const m of typeText("unter2")) late.r.input(m);
  expect(JSON.stringify(await late.r.finish())).not.toContain("ctrl+");

  // Where the field couldn't be checked (the desktop slow to answer), none of them is kept.
  const failed = recorder(async () => {
    throw new Error("The operation timed out.");
  });
  keys(failed.r, ["Control", true]);
  for (const m of typeText("hunter2")) failed.r.input(m);
  const unchecked = await failed.r.finish();
  expect(unchecked.every((s) => s.kind === "key" && s.key === "" && s.hidden === "unknown")).toBe(
    true,
  );
  expect(describeSteps(unchecked).lines[0]).toBe(
    "[0.0s] pressed a key with a modifier (not recorded: the field couldn't be checked)",
  );

  // Between two hidden runs, a character with a modifier is hidden even if its own check said no.
  const answers = [true, false, true];
  let n = 0;
  const between = recorder(async () => answers[n++] ?? false);
  for (const m of typeText("abc")) between.r.input(m);
  keys(between.r, ["Meta", true], ["q", true], ["q", false], ["Meta", false]);
  for (const m of typeText("def")) between.r.input(m);
  const mixed = await between.r.finish();
  expect(mixed.map((s) => s.kind === "key" && s.hidden)).toEqual([false, "secret", false]);
  expect(JSON.stringify(mixed)).not.toContain("super+q");
});

test("no screenshot is kept after hidden typing on the page, or while a secret field holds something", async () => {
  let secretShown = false;
  const { r } = recorder(
    async () => ({ secret: true, url: "https://bank.example/pay" }),
    async () => (secretShown ? null : new Uint8Array([1])),
  );
  r.page("https://bank.example/pay", "Pay");
  for (const m of click(10, 10)) r.input(m);
  for (const m of typeText("4111111111111111")) r.input(m);
  for (const m of click(20, 20)) r.input(m);
  for (const m of press("Enter")) r.input(m);
  // A new title isn't a new page; a new address is.
  r.page("https://bank.example/pay", "Pay (1)");
  for (const m of click(30, 30)) r.input(m);
  r.page("https://bank.example/done", "Done");
  for (const m of click(40, 40)) r.input(m);
  secretShown = true;
  for (const m of click(50, 50)) r.input(m);
  const steps = await r.finish();
  const shots = steps.flatMap((s) => (s.kind === "button" && s.down ? [Boolean(s.screen)] : []));
  expect(shots).toEqual([true, false, false, true, false]);
  const enter = steps.find((s) => s.kind === "key");
  expect(enter).toEqual({ t: 0, kind: "key", key: "Enter" });
});

test("hidden typing keeps its page's screenshots out, however the address came and went", async () => {
  const checkout = "https://shop.example/checkout";
  const typeOn = async (steps: (r: Recorder) => void) => {
    const { r, saved } = recorder(async () => ({ secret: true, url: checkout }));
    r.page(checkout, "Checkout");
    steps(r);
    for (const m of click(50, 50)) r.input(m);
    await r.finish();
    return saved;
  };
  const card = (r: Recorder) => {
    for (const m of typeText("4242424242424242")) r.input(m);
  };
  // A look at another tab and back; the page adding a query; a moment the address couldn't be read.
  expect(
    await typeOn((r) => {
      card(r);
      r.page("https://mail.example/inbox", "Inbox");
      r.page(checkout, "Checkout");
    }),
  ).toEqual([]);
  expect(
    await typeOn((r) => {
      card(r);
      r.page(`${checkout}?step=confirm`, "Checkout");
    }),
  ).toEqual([]);
  expect(
    await typeOn((r) => {
      card(r);
      r.page(null, null);
      r.page(checkout, "Checkout");
    }),
  ).toEqual([]);
  // A paste into the card's frame is typing too.
  expect(
    await typeOn((r) => {
      keys(r, ["Control", true], ["v", true], ["v", false], ["Control", false]);
    }),
  ).toEqual([]);
  // Another page is fine, once the address has changed.
  expect(
    await typeOn((r) => {
      card(r);
      r.page("https://shop.example/thanks", "Thanks");
    }),
  ).toEqual(["5-click"]);
});

test("a search typed in the address bar holds screenshots back only until the address changes", async () => {
  let url = "https://www.google.com/search?q=a";
  let onPage = true;
  const { r, saved, tick } = recorder(
    async () => {
      if (!onPage) throw new OffPage("the keyboard isn't on a page");
      return { secret: false, url };
    },
    async () => ({ bytes: new Uint8Array([1]), url }),
  );
  r.page(url, "a");
  onPage = false;
  for (const m of click(1, 1)) r.input(m);
  for (const m of typeText("dune")) r.input(m);
  for (const m of press("Enter")) r.input(m);
  tick(2000);
  // The same path, another query: a new address all the same.
  url = "https://www.google.com/search?q=dune";
  onPage = true;
  r.page(url, "dune - Google");
  for (const m of click(100, 100)) r.input(m);
  for (const m of click(100, 200)) r.input(m);
  await r.finish();
  expect(saved).toEqual(["3-click", "9-click", "12-click"]);
});

test("typing on a page the address poll hasn't seen yet counts for that page", async () => {
  // The field check knows where it was typed.
  const known = recorder(async () => ({ secret: true, url: "https://shop.example/blik" }));
  known.r.page("https://shop.example/cart", "Cart");
  for (const m of typeText("123456")) known.r.input(m);
  known.r.page("https://shop.example/blik", "BLIK");
  known.tick(60_000);
  for (const m of click(50, 50)) known.r.input(m);
  known.r.page("https://shop.example/cart", "Cart");
  for (const m of click(60, 60)) known.r.input(m);
  await known.r.finish();
  expect(known.saved).toEqual(["9-click"]);
  // Or the screenshot does: the address on screen when it was taken.
  const late = recorder(
    async () => ({ secret: true, url: "https://shop.example/blik" }),
    async () => ({ bytes: new Uint8Array([1]), url: "https://shop.example/blik" }),
  );
  late.r.page("https://shop.example/cart", "Cart");
  for (const m of typeText("123456")) late.r.input(m);
  late.r.page("https://shop.example/cart?x=1", "Cart");
  late.tick(60_000);
  for (const m of click(50, 50)) late.r.input(m);
  await late.r.finish();
  expect(late.saved).toEqual([]);

  // A check that couldn't say: the next address, seen soon after, counts too.
  const unsure = recorder(async () => {
    throw new Error("timed out");
  });
  unsure.r.page("https://shop.example/cart", "Cart");
  for (const m of click(10, 10)) unsure.r.input(m);
  for (const m of typeText("123456")) unsure.r.input(m);
  unsure.tick(1000);
  unsure.r.page("https://shop.example/blik", "BLIK");
  for (const m of click(50, 50)) unsure.r.input(m);
  await unsure.r.finish();
  expect(unsure.saved).toEqual(["3-click"]);
});

test("a press and release apart is a drag", () => {
  const { lines } = describeSteps([
    { t: 0, kind: "button", button: 1, down: true, x: 10, y: 10 },
    { t: 300, kind: "button", button: 1, down: false, x: 200, y: 10 },
  ]);
  expect(lines).toEqual([
    "[0.0s] left button pressed at (10, 10)",
    "[0.3s] left button released at (200, 10) (a drag)",
  ]);
});

test("INDEX.md keeps one Skills section, in place", () => {
  const index = "# Memory index\n\n- about-you.md: who you are\n\n## Projects\n- projects/x.md\n";
  const one = withSkillsSection(index, [{ name: "a", description: "Do A." }]);
  expect(one).toBe(
    "# Memory index\n\n- about-you.md: who you are\n\n## Projects\n- projects/x.md\n\n## Skills\n\n- skills/a.md: Do A.\n",
  );
  const two = withSkillsSection(
    one.replace("## Projects\n- projects/x.md\n\n## Skills", "## Skills").concat("\n## Later\n"),
    [
      { name: "a", description: "Do A." },
      { name: "b", description: "Do B." },
    ],
  );
  expect(two).toBe(
    "# Memory index\n\n- about-you.md: who you are\n\n## Skills\n\n- skills/a.md: Do A.\n- skills/b.md: Do B.\n\n## Later\n",
  );
  expect(withSkillsSection(two, [])).toBe(
    "# Memory index\n\n- about-you.md: who you are\n\n## Later\n",
  );
  expect(describeSkill(SKILL)).toBe("Renew borrowed books on the city library site.");
  expect(describeSkill("# Water plants\n\n## When to use\n- Every Sunday.\n")).toBe(
    "Every Sunday.",
  );
});

test("INDEX.md's Skills section follows the files in skills/, however they changed", async () => {
  const t = await testApp();
  // Written as a plain file, and the skills list never heard of it.
  await t.memory.write(
    "skills/pay-rent.md",
    "---\ndescription: Pay the rent\n---\n# Pay rent\n",
    HATBOT,
    "Add",
  );
  expect(t.skills.list()).toEqual([]);
  await t.skills.save("order-pizza", "---\ndescription: Order pizza\n---\n# Order pizza\n", HATBOT);
  const index = await t.memory.read("INDEX.md");
  expect(index).toContain(
    "## Skills\n\n- skills/order-pizza.md: Order pizza\n- skills/pay-rent.md: Pay the rent\n",
  );

  // Deleted as a plain file: the next refresh takes it out, in a commit of its own.
  await t.memory.delete("skills/pay-rent.md", HATBOT, "Remove");
  await t.skills.refresh();
  expect(await t.memory.read("INDEX.md")).not.toContain("pay-rent");
  const [last] = await t.memory.log(1);
  expect(last).toMatchObject({ message: "List the skills in INDEX.md", files: ["INDEX.md"] });
  expect(t.events.some((e) => e.type === "memory.committed" && e.sha === last?.sha)).toBe(true);
  await waitFor(async () => (await t.memory.log(1))[0]?.sha === last?.sha);
  // When it lists them already: no commit.
  await t.skills.refresh();
  expect((await t.memory.log(1))[0]?.sha).toBe(last?.sha);
});

/** A test app whose task model writes SKILL when asked to draft. */
async function teachApp() {
  const work = new FakeModel();
  const t = await testApp(new FakeModel(), work);
  work.onCreate = (p) =>
    p.system === TEACH_PROMPT ? SKILL : '{"suspected": false, "excerpt": ""}';
  await t.desktop.refresh();
  const { cookie } = await setUpOwner(t);
  const call = (method: string, path: string, body?: unknown) =>
    t.call(method, path, body, { cookie });
  return { t, work, call, cookie };
}

type Call = (method: string, path: string, body?: unknown) => Response | Promise<Response>;

/** The recording's screenshots in the archive. */
function screensOf(t: TestApp, id: number): string[] {
  const root = join(t.archive.dir, "screens");
  if (!existsSync(root)) return [];
  return readdirSync(root, { recursive: true })
    .map(String)
    .filter((p) => p.includes(`teach-${id}/`) && p.endsWith(".webp"));
}

async function record(t: TestApp, call: Call, show?: () => Promise<void>) {
  const res = await call("POST", "/teach/start", {});
  expect(res.status).toBe(200);
  const session = (await res.json()) as TeachSession;
  expect(session.status).toBe("recording");
  for (const m of click(400, 300)) t.teach.input(m);
  if (show) {
    await show();
    return session;
  }
  t.agent.element = {
    tag: "input",
    role: null,
    type: "password",
    label: "",
    inForm: true,
  };
  for (const m of typeText("s3cret-pw")) t.teach.input(m);
  await Bun.sleep(1);
  t.agent.element = { tag: "input", role: null, type: "text", label: "Search", inForm: true };
  for (const m of click(500, 120)) t.teach.input(m);
  for (const m of typeText("Dune")) t.teach.input(m);
  for (const m of press("Enter")) t.teach.input(m);
  return session;
}

test("record, draft and save a skill: the desktop is yours meanwhile, secrets stay out", async () => {
  const { t, work, call } = await teachApp();
  const session = await record(t, call);
  expect(t.desktop.get().control).toBe("owner");
  expect(t.agent.locked).toBe(true);
  // A desktop task waits for the recording to end.
  const task = t.tasks.createDesktopTask({
    title: "Check",
    goal: "Check",
    successCriteria: "",
    origin: "chat",
  });
  await Bun.sleep(20);
  expect(t.tasks.get(task.id)?.status).toBe("queued");
  await t.tasks.cancel(task.id);

  const stopped = (await (await call("POST", "/teach/stop")).json()) as TeachSession;
  expect(stopped.status).toBe("drafting");
  expect(t.desktop.get().control).toBe("hatbot");
  expect(t.tasks.lane.holderId).toBeNull();
  const draft = await waitFor(() => {
    const s = t.teach.get(session.id);
    return s?.status === "draft" ? s : null;
  });
  expect(draft.name).toBe("renew-library-books");
  expect(draft.draft).toBe(SKILL);

  // One Opus call: the step log and the screenshots, without the password.
  const req = work.creates.find((p) => p.system === TEACH_PROMPT);
  expect(req?.model).toBe("claude-opus-5-5");
  const body = JSON.stringify(req?.messages);
  expect(body).not.toContain("s3cret");
  expect(body).toContain("typed 9 characters into a password or code field");
  expect(body).toContain('typed \\"Dune\\"');
  const content = req?.messages[0]?.content as { type: string }[];
  // The click before the password; none after it on that page, where it might still show.
  const images = content.filter((b) => b.type === "image");
  expect(images).toHaveLength(1);
  expect(t.agent.screenshots).toBe(3);
  expect(t.db.query("SELECT purpose FROM spend_ledger").all()).toContainEqual({
    purpose: "teach",
  });
  const shots = screensOf(t, session.id);
  expect(shots).toHaveLength(1);

  const saved = await call("POST", `/teach/${session.id}/save`, {
    name: "renew-books",
    content: SKILL,
  });
  expect(saved.status).toBe(200);
  expect(await t.memory.read("skills/renew-books.md")).toBe(`${SKILL}\n`);
  expect(await t.memory.read("INDEX.md")).toContain(
    "## Skills\n\n- skills/renew-books.md: Renew borrowed books on the city library site.",
  );
  const [commit] = await t.memory.log(1);
  expect(commit?.files.sort()).toEqual(["INDEX.md", "skills/renew-books.md"]);
  expect(commit?.author).toBe(t.settings.get().owner.name);
  expect(t.skills.list()).toEqual([
    { name: "renew-books", description: "Renew borrowed books on the city library site." },
  ]);
  expect(t.teach.get(session.id)?.status).toBe("saved");
  expect(
    (await call("POST", `/teach/${session.id}/save`, { name: "x", content: "y" })).status,
  ).toBe(409);
  // Saved: the screenshots are gone, and nothing points at them.
  expect(screensOf(t, session.id)).toEqual([]);
  const row = t.db
    .query<{ events: string }, [number]>("SELECT events FROM teach_sessions WHERE id = ?")
    .get(session.id);
  expect(row?.events).not.toContain("screen");
});

test("typing while the page hasn't the keyboard isn't kept, nor a screenshot while a secret shows", async () => {
  const { t, work, call } = await teachApp();
  const session = await record(t, call, async () => {
    // A card number the page shows: the click's screenshot isn't kept.
    t.agent.page = { ...t.agent.page, secretShown: true };
    for (const m of click(600, 300)) t.teach.input(m);
    await Bun.sleep(1);
    t.agent.page = { ...t.agent.page, secretShown: false };
    // The address bar has the keyboard, though the page's search box still has focus there.
    t.agent.element = {
      tag: "input",
      role: null,
      type: "text",
      label: "Search",
      inForm: true,
      pageFocus: false,
    };
    for (const m of typeText("my-pin-1234")) t.teach.input(m);
  });
  await call("POST", "/teach/stop");
  await waitFor(() => t.teach.get(session.id)?.status === "draft");
  const body = JSON.stringify(work.creates.find((p) => p.system === TEACH_PROMPT)?.messages);
  expect(body).toContain("left click at (400, 300) [screenshot 1]");
  expect(body).toContain("left click at (600, 300)\\n");
  expect(body).not.toContain("my-pin");
  expect(body).toContain("typed 11 characters (not recorded: the field couldn't be checked)");
});

test("a screenshot the page can't vouch for isn't kept", async () => {
  const { t, work, call } = await teachApp();
  const context = t.agent.context.bind(t.agent);
  const session = await record(t, call, async () => {
    // The page is too busy to say whether a card number shows.
    t.agent.context = async (withText = false, secrets = false) => {
      if (secrets) throw new Error("The operation timed out.");
      return context(withText, secrets);
    };
    for (const m of click(600, 300)) t.teach.input(m);
    await Bun.sleep(1);
  });
  await call("POST", "/teach/stop");
  await waitFor(() => t.teach.get(session.id)?.status === "draft");
  const body = JSON.stringify(work.creates.find((p) => p.system === TEACH_PROMPT)?.messages);
  expect(body).toContain("left click at (400, 300) [screenshot 1]");
  expect(body).toContain("left click at (600, 300)\\n");
  expect(screensOf(t, session.id)).toHaveLength(1);
});

test("a live view that closes with a modifier down leaves none held in the recording", async () => {
  const { t, work, call, cookie } = await teachApp();
  const agent = Bun.serve({
    port: 0,
    fetch: (req, srv) => (srv.upgrade(req) ? undefined : new Response(null, { status: 400 })),
    websocket: { message() {} },
  });
  t.agent.liveSocket = () => ({ url: `ws://127.0.0.1:${agent.port}/live`, headers: {} });
  const brain = Bun.serve({ port: 0, fetch: (req, srv) => t.app.fetch(req, srv), websocket });
  const open = async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${brain.port}/api/v1/desktop/live`, {
      headers: { cookie, origin: ORIGIN },
    } as unknown as string[]);
    await new Promise((r) => (ws.onopen = r));
    return ws;
  };
  try {
    const session = await record(t, call, async () => {
      const first = await open();
      await Bun.sleep(50);
      // Ctrl goes down, then the view's link drops: its key up never comes.
      first.send(JSON.stringify({ t: "key", key: "Control", down: true }));
      await Bun.sleep(50);
      first.close();
      await Bun.sleep(50);
      t.agent.element = { tag: "input", role: null, type: "text", label: "Search", inForm: true };
      for (const m of typeText("dune")) t.teach.input(m);
    });
    await call("POST", "/teach/stop");
    await waitFor(() => t.teach.get(session.id)?.status === "draft");
    const body = JSON.stringify(work.creates.find((p) => p.system === TEACH_PROMPT)?.messages);
    expect(body).toContain('typed \\"dune\\"');
    expect(body).not.toContain("ctrl+d");
  } finally {
    brain.stop(true);
    agent.stop(true);
  }
});

test("discarding a recording deletes its screenshots, a restart's too", async () => {
  const { t, call } = await teachApp();
  const first = await record(t, call);
  expect(screensOf(t, first.id).length).toBeGreaterThan(0);
  await call("DELETE", `/teach/${first.id}`);
  expect(screensOf(t, first.id)).toEqual([]);

  const second = await record(t, call);
  expect(screensOf(t, second.id).length).toBeGreaterThan(0);
  // A brain that restarts mid-recording.
  await Bun.sleep(5);
  t.teach.close();
  const again = new Teach({
    db: t.db,
    events: { on: () => {}, emit: () => {} } as unknown as EventBus,
    desktop: t.desktop,
    lane: t.tasks.lane,
    archive: t.archive,
    model: new FakeModel(),
    spend: t.spend,
    settings: t.settings,
    skills: t.skills,
  });
  await waitFor(() => screensOf(t, second.id).length === 0);
  expect(again.get(second.id)?.status).toBe("discarded");
});

test("a recording discarded while it stops stays discarded", async () => {
  const { t, work, call } = await teachApp();
  const session = await record(t, call);
  const stopping = t.teach.stop();
  await t.teach.discard(session.id);
  expect((await stopping).status).toBe("discarded");
  await Bun.sleep(5);
  expect(t.teach.get(session.id)?.status).toBe("discarded");
  expect(work.creates.some((p) => p.system === TEACH_PROMPT)).toBe(false);
});

test("typing into a frame isn't kept", async () => {
  const { t, work, call } = await teachApp();
  const session = await record(t, call, async () => {
    t.agent.element = { tag: "frame", role: null, type: null, label: "", inForm: false };
    for (const m of typeText("4111111111111111")) t.teach.input(m);
    await Bun.sleep(1);
  });
  await call("POST", "/teach/stop");
  await waitFor(() => t.teach.get(session.id)?.status === "draft");
  const body = JSON.stringify(work.creates.find((p) => p.system === TEACH_PROMPT)?.messages);
  expect(body).not.toContain("4111");
  expect(body).toContain("typed 16 characters into a password or code field");
});

test("a skill name that's taken needs replace; bad names are refused", async () => {
  const { t, call } = await teachApp();
  await t.memory.write("skills/renew-library-books.md", "# Old\n", t.settings.get().owner, "Old");
  const session = await record(t, call);
  await call("POST", "/teach/stop");
  await waitFor(() => t.teach.get(session.id)?.status === "draft");
  const save = (body: unknown) => call("POST", `/teach/${session.id}/save`, body);
  expect((await save({ name: "Renew Books", content: SKILL })).status).toBe(400);
  const taken = await save({ name: "renew-library-books", content: SKILL });
  expect(taken.status).toBe(409);
  expect(((await taken.json()) as { error: string }).error).toContain("already a skill");
  expect((await save({ name: "renew-library-books", content: SKILL, replace: true })).status).toBe(
    200,
  );
  expect(await t.memory.read("skills/renew-library-books.md")).toBe(`${SKILL}\n`);
});

test("discarding a recording, or handing back, ends it without a skill", async () => {
  const { t, work, call } = await teachApp();
  const first = await record(t, call);
  expect((await call("DELETE", `/teach/${first.id}`)).status).toBe(200);
  expect(t.teach.get(first.id)?.status).toBe("discarded");
  expect(t.desktop.get().control).toBe("hatbot");
  expect(t.tasks.lane.holderId).toBeNull();

  const second = await record(t, call);
  await call("POST", "/desktop/handback");
  await waitFor(() => t.teach.get(second.id)?.status === "discarded");
  expect(t.tasks.lane.holderId).toBeNull();
  expect(work.creates.some((p) => p.system === TEACH_PROMPT)).toBe(false);
  expect((await call("POST", "/teach/stop")).status).toBe(409);
});

test("teach can't start while a task has the desktop; an empty recording isn't drafted", async () => {
  const work = new FakeModel([{ content: [toolUse("request_takeover", { reason: "Log in" })] }]);
  const t = await testApp(new FakeModel(), work);
  await t.desktop.refresh();
  const { cookie } = await setUpOwner(t);
  const call = (method: string, path: string, body?: unknown) =>
    t.call(method, path, body, { cookie });
  const task = t.tasks.createDesktopTask({
    title: "Log in",
    goal: "Log in",
    successCriteria: "",
    origin: "chat",
  });
  await waitFor(() => t.tasks.get(task.id)?.status === "waiting_takeover");
  // Asking for you leaves the screen free; once you take over for it, the task has it.
  expect((await call("POST", "/desktop/takeover")).status).toBe(200);
  expect(t.tasks.lane.holderId).toBe(task.id);
  const busy = await call("POST", "/teach/start", {});
  expect(busy.status).toBe(409);
  await t.tasks.cancel(task.id);
  await t.tasks.idle();

  await call("POST", "/teach/start", {});
  const stopped = (await (await call("POST", "/teach/stop")).json()) as TeachSession;
  expect(stopped.status).toBe("failed");
  expect(stopped.error).toContain("Nothing was recorded");
  expect((await call("POST", `/teach/${stopped.id}/draft`)).status).toBe(409);
  expect((await call("GET", "/teach")).status).toBe(200);
  expect((await t.call("POST", "/teach/start")).status).toBe(401);
  // A body that isn't an object, or a name a skill can't have, is refused before anything starts.
  expect((await call("POST", "/teach/start", null)).status).toBe(400);
  const bad = await call("POST", "/teach/start", { replaces: "Renew Books" });
  expect(bad.status).toBe(400);
  expect(await bad.json()).toEqual({
    error: "Use lowercase letters, digits and dashes.",
    field: "replaces",
  });
  expect(t.desktop.get().control).toBe("hatbot");
});

test("a failed draft can be written again", async () => {
  const { t, work, call } = await teachApp();
  let fail = true;
  work.onCreate = (p) => {
    if (p.system !== TEACH_PROMPT) return '{"suspected": false, "excerpt": ""}';
    if (fail) throw new Error("overloaded");
    return SKILL;
  };
  const session = await record(t, call);
  await call("POST", "/teach/stop");
  const failed = await waitFor(() => {
    const s = t.teach.get(session.id);
    return s?.status === "failed" ? s : null;
  });
  expect(failed.error).toBe("Failed: overloaded");
  fail = false;
  expect((await call("POST", `/teach/${session.id}/draft`)).status).toBe(200);
  await waitFor(() => t.teach.get(session.id)?.status === "draft");
});

test("tasks see skills: background tasks get the list, desktop tasks get the steps", async () => {
  const chat = new FakeModel([
    {
      content: [
        toolUse("run_desktop_task", {
          title: "Renew",
          goal: "Renew my books",
          success_criteria: "",
          skill: "no-such-skill",
        }),
      ],
    },
    { content: [text("No such skill.")] },
  ]);
  const work = new FakeModel([
    {
      content: [
        toolUse("run_desktop_task", {
          title: "Renew books",
          goal: "Renew every book",
          success_criteria: "All renewed",
          skill: "renew-library-books",
        }),
      ],
    },
    // The desktop task.
    { content: [toolUse("finish_task", { outcome: "done", summary: "Renewed 3 books." })] },
    { content: [toolUse("finish_task", { outcome: "done", summary: "Done.", notify: false })] },
  ]);
  const t = await testApp(chat, work);
  await t.skills.save("renew-library-books", SKILL, t.settings.get().owner);

  t.thread.post("renew my books");
  await t.thread.idle();
  const refused = JSON.stringify(chat.requests[1]?.messages.at(-1)?.content);
  expect(refused).toContain('There\'s no skill called \\"no-such-skill\\"');

  t.tasks.createBackgroundTask({ title: "Renew", goal: "Renew my books", origin: "schedule" });
  await t.tasks.idle();
  const first = JSON.stringify(work.requests[0]?.messages[0]?.content);
  expect(first).toContain(
    "<skills>\\n- renew-library-books: Renew borrowed books on the city library site.\\n</skills>",
  );
  const desktop = t.tasks.list({}).find((x) => x.lane === "screen");
  expect(desktop?.skill).toBe("renew-library-books");
  const steps = JSON.stringify(work.requests[1]?.messages[0]?.content);
  expect(steps).toContain('<skill name=\\"renew-library-books\\">');
  expect(steps).toContain("Click Renew all.");
});
