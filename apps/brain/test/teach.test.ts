import { expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { TeachSession } from "@hatbot/shared";
import type { LiveInput } from "@hatbot/shared/desktop";
import { TEACH_PROMPT } from "../src/agent/prompt";
import type { EventBus } from "../src/events";
import { HATBOT } from "../src/memory/store";
import { type FieldCheck, OffPage, Recorder } from "../src/teach/recorder";
import { Teach } from "../src/teach/service";
import { FakeModel } from "./fake-model";
import { signIn, type TestApp, testApp, waitFor } from "./helpers";

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
  let shots = 0;
  const saved: string[] = [];
  const r = new Recorder({
    clock: () => 0,
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
  return { r, saved };
}

const keys = (r: Recorder, ...ms: [string, boolean][]) => {
  for (const [key, down] of ms) r.input({ t: "key", key, down });
};
const input = (r: Recorder, ms: LiveInput[]) => {
  for (const m of ms) r.input(m);
};

test("typing into a secret field, or one that can't be checked, isn't kept, whatever keys made it", async () => {
  const answers = [true, false, "fail"] as const;
  let n = 0;
  const { r } = recorder(async () => {
    const a = answers[n++];
    if (a === "fail") throw new Error("no focused element");
    return a === true;
  });
  input(r, typeText("hunter22"));
  input(r, press("Tab"));
  input(r, typeText("visible"));
  input(r, click(10, 10));
  input(r, typeText("unseen"));
  const steps = await r.finish();
  expect(steps.filter((s) => s.kind === "text")).toEqual([
    { t: 0, kind: "text", text: "", hidden: "secret", chars: 8 },
    { t: 0, kind: "text", text: "visible", chars: 7 },
    { t: 0, kind: "text", text: "", hidden: "unknown", chars: 6 },
  ]);

  // AltGr (Linux, or Ctrl and Alt together on Windows) and a Mac's Option type characters too.
  const alt = recorder(async () => true).r;
  keys(alt, ["AltGraph", true]);
  input(alt, typeText("ąę"));
  keys(alt, ["AltGraph", false], ["Control", true], ["Alt", true]);
  input(alt, typeText("łś"));
  keys(alt, ["Alt", false], ["Control", false], ["Alt", true]);
  input(alt, typeText("ż"));
  keys(alt, ["Alt", false]);
  expect(await alt.finish()).toEqual([
    { t: 0, kind: "text", text: "", hidden: "secret", chars: 5 },
  ]);
});

test("a stuck modifier doesn't leave hidden typing in clear as shortcuts", async () => {
  // Ctrl went down, and its up never came: every key is ctrl+something.
  const { r } = recorder(async () => true);
  keys(r, ["Control", true]);
  input(r, typeText("hunter2"));
  const steps = await r.finish();
  expect(steps).toHaveLength(7);
  expect(steps.every((s) => s.kind === "key" && s.key === "" && s.hidden === "secret")).toBe(true);

  // Off the page (the address bar), one shortcut is kept; a run of them is typing with a stuck modifier
  // (in Chromium's own sign-in prompt, say), and none is.
  const offPage = async () => {
    throw new OffPage("the keyboard isn't on a page");
  };
  const outside = recorder(offPage);
  keys(outside.r, ["Control", true], ["l", true], ["l", false], ["Control", false]);
  expect(await outside.r.finish()).toEqual([{ t: 0, kind: "key", key: "ctrl+l" }]);
  const prompt = recorder(offPage);
  keys(prompt.r, ["Control", true]);
  input(prompt.r, typeText("hunter2"));
  expect(JSON.stringify(await prompt.r.finish())).not.toContain("ctrl+");
});

test("no screenshot is kept on a page after hidden typing there, however its address came and went, or while a secret shows", async () => {
  let secretShown = false;
  const { r } = recorder(
    async () => ({ secret: true, url: "https://bank.example/pay" }),
    async () => (secretShown ? null : new Uint8Array([1])),
  );
  r.page("https://bank.example/pay", "Pay");
  input(r, click(10, 10));
  input(r, typeText("4111111111111111"));
  input(r, click(20, 20));
  // A new title isn't a new page; a look at another tab and back, or a query added, isn't either.
  r.page("https://bank.example/pay", "Pay (1)");
  input(r, click(30, 30));
  r.page("https://mail.example/inbox", "Inbox");
  r.page("https://bank.example/pay", "Pay");
  input(r, click(40, 40));
  r.page("https://bank.example/pay?step=confirm", "Pay");
  input(r, click(50, 50));
  r.page("https://bank.example/done", "Done");
  input(r, click(60, 60));
  secretShown = true;
  input(r, click(70, 70));
  const steps = await r.finish();
  const shots = steps.flatMap((s) => (s.kind === "button" && s.down ? [Boolean(s.screen)] : []));
  expect(shots).toEqual([true, false, false, false, false, true, false]);
});

test("INDEX.md's Skills section follows the files in skills/, and the rest of INDEX.md stays", async () => {
  const t = await testApp();
  const index = "# Memory index\n\n- about-you.md: who you are\n\n## Projects\n- projects/x.md\n";
  await t.memory.write("INDEX.md", index, HATBOT, "Index");
  // Written as a plain file, and the skills list never heard of it.
  await t.memory.write(
    "skills/pay-rent.md",
    "---\ndescription: Pay the rent\n---\n# Pay rent\n",
    HATBOT,
    "Add",
  );
  await t.skills.save("order-pizza", "---\ndescription: Order pizza\n---\n# Order pizza\n", HATBOT);
  expect(await t.memory.read("INDEX.md")).toBe(
    `${index}\n## Skills\n\n- skills/order-pizza.md: Order pizza\n- skills/pay-rent.md: Pay the rent\n`,
  );

  // Deleted as a plain file: the next refresh takes it out.
  await t.memory.delete("skills/pay-rent.md", HATBOT, "Remove");
  await t.skills.refresh();
  expect(await t.memory.read("INDEX.md")).toBe(
    `${index}\n## Skills\n\n- skills/order-pizza.md: Order pizza\n`,
  );
  // When it lists them already: no commit.
  const [last] = await t.memory.log(1);
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
  const { cookie } = signIn(t);
  const call = (method: string, path: string, body?: unknown) =>
    t.call(method, path, body, { cookie });
  return { t, work, call };
}

type Call = (method: string, path: string, body?: unknown) => Response | Promise<Response>;

function screensOf(t: TestApp, id: number): string[] {
  const root = join(t.archive.dir, "screens");
  if (!existsSync(root)) return [];
  return readdirSync(root, { recursive: true })
    .map(String)
    .filter((p) => p.includes(`teach-${id}/`) && p.endsWith(".webp"));
}

/** A click, then a password and a search, or what `show` does instead; its first screenshot is saved. */
async function record(t: TestApp, call: Call, show?: () => void) {
  const res = await call("POST", "/teach/start", {});
  expect(res.status).toBe(200);
  const session = (await res.json()) as TeachSession;
  for (const m of click(400, 300)) t.teach.input(m);
  if (show) show();
  else {
    t.agent.element = { tag: "input", role: null, type: "password", label: "", inForm: true };
    for (const m of typeText("s3cret-pw")) t.teach.input(m);
    t.agent.element = { tag: "input", role: null, type: "text", label: "Search", inForm: true };
    for (const m of click(500, 120)) t.teach.input(m);
    for (const m of typeText("Dune")) t.teach.input(m);
    for (const m of press("Enter")) t.teach.input(m);
  }
  await waitFor(() => screensOf(t, session.id).length);
  return session;
}

/** Stops the recording and waits for its draft; what the draft request was sent. */
async function drafted(t: TestApp, work: FakeModel, call: Call, id: number) {
  await call("POST", "/teach/stop");
  await waitFor(() => t.teach.get(id)?.status === "draft");
  return JSON.stringify(work.creates.find((p) => p.system === TEACH_PROMPT)?.messages);
}

test("record, draft and save a skill: the desktop is yours meanwhile, secrets stay out, and the draft's cost is held", async () => {
  const { t, work, call } = await teachApp();
  /** Whether a request is held against today's limit, so what's left of it can't all be spent. */
  const holding = () => {
    const { dailyUsd, alertReserveUsd } = t.settings.get().limits;
    try {
      t.spend.check(dailyUsd - alertReserveUsd - 0.0005);
      return false;
    } catch {
      return true;
    }
  };
  let heldMeanwhile = false;
  work.onCreate = (p) => {
    if (p.system !== TEACH_PROMPT) return '{"suspected": false, "excerpt": ""}';
    heldMeanwhile = holding();
    return SKILL;
  };
  const session = await record(t, call);
  expect(t.desktop.get().control).toBe("owner");
  expect(t.agent.locked).toBe(true);
  expect(t.tasks.lane.holderId).not.toBeNull();
  expect(holding()).toBe(false);

  const body = await drafted(t, work, call, session.id);
  expect(t.desktop.get().control).toBe("hatbot");
  expect(t.tasks.lane.holderId).toBeNull();
  expect(t.teach.get(session.id)).toMatchObject({ name: "renew-library-books", draft: SKILL });
  expect(heldMeanwhile).toBe(true);
  expect(t.db.query("SELECT purpose FROM spend_ledger").all()).toContainEqual({
    purpose: "teach",
  });
  // The step log and the click before the password, which is left out.
  expect(body).not.toContain("s3cret");
  expect(body).toContain('typed \\"Dune\\"');
  const content = work.creates.find((p) => p.system === TEACH_PROMPT)?.messages[0]?.content as {
    type: string;
  }[];
  expect(content.filter((b) => b.type === "image")).toHaveLength(1);

  const saved = await call("POST", `/teach/${session.id}/save`, {
    name: "renew-books",
    content: SKILL,
  });
  expect(saved.status).toBe(200);
  expect(await t.memory.read("skills/renew-books.md")).toBe(`${SKILL}\n`);
  const [commit] = await t.memory.log(1);
  expect(commit?.files.sort()).toEqual(["INDEX.md", "skills/renew-books.md"]);
  expect(commit?.author).toBe(t.settings.get().owner.name);
  expect(
    (await call("POST", `/teach/${session.id}/save`, { name: "x", content: "y" })).status,
  ).toBe(409);
  expect(screensOf(t, session.id)).toEqual([]);
});

test("typing where the page hasn't the keyboard, or into a frame, isn't kept, nor a screenshot a secret may show", async () => {
  const { t, work, call } = await teachApp();
  const context = t.agent.context.bind(t.agent);
  const session = await record(t, call, () => {
    // A card number the page shows.
    t.agent.page = { ...t.agent.page, secretShown: true };
    for (const m of click(600, 300)) t.teach.input(m);
    t.agent.page = { ...t.agent.page, secretShown: false };
    // The page too busy to say whether one shows.
    t.agent.context = async (withText = false, secrets = false) => {
      if (secrets) throw new Error("The operation timed out.");
      return context(withText, secrets);
    };
    for (const m of click(650, 300)) t.teach.input(m);
    t.agent.context = context;
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
    // A frame, which can't be seen into.
    t.agent.element = { tag: "frame", role: null, type: null, label: "", inForm: false };
    for (const m of click(500, 400)) t.teach.input(m);
    for (const m of typeText("4111111111111111")) t.teach.input(m);
  });
  const body = await drafted(t, work, call, session.id);
  expect(body).toContain("left click at (400, 300) [screenshot 1]");
  expect(body).toContain("left click at (600, 300)\\n");
  expect(body).toContain("left click at (650, 300)\\n");
  expect(body).not.toContain("my-pin");
  expect(body).not.toContain("4111");
});

test("a recording discarded while Stop hands the desktop back stays discarded", async () => {
  const { t, work, call } = await teachApp();
  const session = await record(t, call);
  const stopping = t.teach.stop();
  await t.teach.discard(session.id);
  expect((await stopping).status).toBe("discarded");
  expect(t.desktop.get().control).toBe("hatbot");
  expect(t.tasks.lane.holderId).toBeNull();
  expect(work.creates.some((p) => p.system === TEACH_PROMPT)).toBe(false);
});

test("discarding a recording deletes its screenshots, a restart's too", async () => {
  const { t, call } = await teachApp();
  const first = await record(t, call);
  await call("DELETE", `/teach/${first.id}`);
  expect(screensOf(t, first.id)).toEqual([]);

  // A brain that restarts mid-recording.
  const second = await record(t, call);
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

test("saving over a skill that's there needs replace", async () => {
  const { t, work, call } = await teachApp();
  await t.memory.write("skills/renew-library-books.md", "# Old\n", t.settings.get().owner, "Old");
  const session = await record(t, call);
  await drafted(t, work, call, session.id);
  const save = (body: unknown) => call("POST", `/teach/${session.id}/save`, body);
  expect((await save({ name: "renew-library-books", content: SKILL })).status).toBe(409);
  expect(await t.memory.read("skills/renew-library-books.md")).toBe("# Old\n");
  expect((await save({ name: "renew-library-books", content: SKILL, replace: true })).status).toBe(
    200,
  );
  expect(await t.memory.read("skills/renew-library-books.md")).toBe(`${SKILL}\n`);
});
