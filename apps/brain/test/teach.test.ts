import { afterEach, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  type DesktopService,
  type FieldCheck,
  type Live,
  OffPage,
  Recorder,
  secretField,
  TEACH_PROMPT,
} from "@hatbot/plugin-desktop";
import type { TeachSession } from "@hatbot/shared";
import type { ComputerField, ComputerFocus } from "@hatbot/shared/computer";
import type { LiveInput } from "@hatbot/shared/desktop";
import { HATBOT } from "../src/memory/store";
import { FakeComputer, withComputer } from "./fake-computer";
import { FakeModel } from "./fake-model";
import { ORIGIN, signIn, type TestApp, testApp, waitFor } from "./helpers";

const stops: (() => void)[] = [];
afterEach(() => {
  for (const s of stops.splice(0)) s();
});

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

/** What the owner does in the live view, as it reaches Teach. */
const live = (t: TestApp) => t.plugins.service<DesktopService>("desktop")?.live as Live;

/** A test app whose task model writes SKILL when asked to draft. */
async function teachApp() {
  const work = new FakeModel();
  const t = await testApp(new FakeModel(), work);
  work.onCreate = (p) => (p.system === TEACH_PROMPT ? SKILL : undefined);
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
  for (const m of click(400, 300)) live(t).input(m);
  if (show) show();
  else {
    t.agent.element = { tag: "input", role: null, type: "password", label: "", inForm: true };
    for (const m of typeText("s3cret-pw")) live(t).input(m);
    t.agent.element = { tag: "input", role: null, type: "text", label: "Search", inForm: true };
    for (const m of click(500, 120)) live(t).input(m);
    for (const m of typeText("Dune")) live(t).input(m);
    for (const m of press("Enter")) live(t).input(m);
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
    if (p.system !== TEACH_PROMPT) return undefined;
    heldMeanwhile = holding();
    return SKILL;
  };
  const session = await record(t, call);
  expect(t.desktop.get().control).toBe("owner");
  expect(t.agent.locked).toBe(true);
  expect(t.lane.holderId).not.toBeNull();
  expect(holding()).toBe(false);

  const body = await drafted(t, work, call, session.id);
  expect(t.desktop.get().control).toBe("hatbot");
  expect(t.lane.holderId).toBeNull();
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
    for (const m of click(600, 300)) live(t).input(m);
    t.agent.page = { ...t.agent.page, secretShown: false };
    // The page too busy to say whether one shows.
    t.agent.context = async (withText = false, secrets = false) => {
      if (secrets) throw new Error("The operation timed out.");
      return context(withText, secrets);
    };
    for (const m of click(650, 300)) live(t).input(m);
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
    for (const m of typeText("my-pin-1234")) live(t).input(m);
    // A frame, which can't be seen into.
    t.agent.element = { tag: "frame", role: null, type: null, label: "", inForm: false };
    for (const m of click(500, 400)) live(t).input(m);
    for (const m of typeText("4111111111111111")) live(t).input(m);
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
  expect(t.lane.holderId).toBeNull();
  expect(work.creates.some((p) => p.system === TEACH_PROMPT)).toBe(false);
});

test("discarding a recording deletes its screenshots, a restart's too", async () => {
  const { t, call } = await teachApp();
  const first = await record(t, call);
  await call("DELETE", `/teach/${first.id}`);
  expect(screensOf(t, first.id)).toEqual([]);

  // A brain that restarts mid-recording.
  const second = await record(t, call);
  await t.plugins.update("desktop", { enabled: false });
  await t.plugins.update("desktop", { enabled: true });
  await waitFor(() => screensOf(t, second.id).length === 0);
  expect(t.teach.get(second.id)?.status).toBe("discarded");
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

const field = (names: string[], o: Partial<ComputerField> = {}): ComputerField => ({
  role: "entry",
  names,
  password: false,
  inFrame: false,
  editable: true,
  ...o,
});

test("a computer's field is secret when its app says it takes a password, it's in a page's frame or a terminal, or its names say so", () => {
  expect(secretField(field(["Password"], { role: "password text", password: true }))).toBe(true);
  expect(secretField(field(["Card number"]))).toBe(true);
  expect(secretField(field(["Numer karty", "cardNumber"]))).toBe(true);
  expect(secretField(field(["One-time code", "otpCode"]))).toBe(true);
  // Stripe's card fields: an input in a frame from another address.
  expect(secretField(field([""], { inFrame: true }))).toBe(true);
  expect(secretField(field(["Terminal"], { role: "terminal" }))).toBe(true);
  expect(secretField(field(["Search", "q"]))).toBe(false);
  expect(secretField(field(["Promo code"]))).toBe(false);
  expect(secretField(field(["Verify your email"]))).toBe(false);
});

/** A computer that can be taught on, answering where the keyboard is from what the test sets. */
function teachable() {
  const computer = new FakeComputer({
    machineId: "m-laptop",
    name: "laptop",
    version: "test",
    compositor: "niri",
    enabled: true,
    features: ["screen", "input", "windows", "atspi", "files", "shell", "live", "teach"],
  });
  const at: { field: ComputerField | null; filled: ComputerField[] } = { field: null, filled: [] };
  computer.answer.focus = (r) => {
    const o = r as Extract<typeof r, { op: "focus" }>;
    const focus: ComputerFocus = {
      window: { title: "Account", appId: "firefox" },
      url: "https://library.example/account",
      ...(o.field ? { field: at.field } : {}),
      ...(o.filled ? { filled: at.filled } : {}),
    };
    return { op: "focus", focus };
  };
  return { computer, at };
}

/**
 * Records on a teachable computer, with a live view open on it: `send` waits for input to reach the
 * computer, and for the checks it sets off to be answered.
 */
async function recordOn(t: TestApp, call: Call) {
  const { computer, at } = teachable();
  const c = await withComputer(t, computer);
  stops.push(c.stop);
  const res = await call("POST", "/teach/start", { screen: "m-laptop" });
  expect(res.status).toBe(200);
  const session = (await res.json()) as TeachSession;
  const ws = new WebSocket(`${c.url}/api/v1/computer/live/m-laptop`, {
    headers: { cookie: signIn(t).cookie, origin: ORIGIN },
  } as unknown as string[]);
  await new Promise((resolve) => {
    ws.onopen = resolve;
  });
  const forwarded = () => computer.requests.filter((r) => r.op === "live_input").length;
  const asked = (k: "field" | "filled") =>
    computer.requests.filter((r) => r.op === "focus" && r[k]).length;
  const send = async (ms: LiveInput[], checks: { field?: number; filled?: number } = {}) => {
    const before = { input: forwarded(), field: asked("field"), filled: asked("filled") };
    for (const m of ms) ws.send(JSON.stringify(m));
    await waitFor(
      () =>
        forwarded() === before.input + ms.length &&
        asked("field") === before.field + (checks.field ?? 0) &&
        asked("filled") === before.filled + (checks.filled ?? 0),
    );
  };
  return { computer, at, session, ws, send };
}

test("Teach on a computer: what you do from Live is recorded and reaches the computer, its secrets stay out, keys you held are let go, and the skill says where it runs", async () => {
  const { t, work, call } = await teachApp();
  const { computer, at, session, ws, send } = await recordOn(t, call);
  expect(session.screen).toBe("m-laptop");
  expect(computer.requests).toContainEqual({ op: "claim", taskId: "-2" });
  expect(t.computers.find("m-laptop")?.control).toBe("owner");
  // No task starts on it meanwhile.
  expect(t.computers.screen("m-laptop")?.lane.holderId).not.toBeNull();

  await send(click(400, 300), { filled: 1 });
  // The browser filled in a password: this click's screenshot isn't kept.
  at.filled = [field(["Password"], { role: "password text", password: true })];
  await send(click(450, 300), { filled: 1 });
  at.field = field(["Search", "q"]);
  at.filled = [field(["Search", "q"])];
  await send(click(500, 120), { filled: 1 });
  await send(typeText("Dune"), { field: 1 });
  await send(press("Enter"), { filled: 1 });
  at.field = field(["Password"], { role: "password text", password: true });
  await send(typeText("s3cret-pw"), { field: 1 });
  await send([{ t: "key", key: "Shift", down: true }]);
  ws.close();
  await waitFor(() =>
    computer.requests.some(
      (r) =>
        r.op === "live_input" && r.input.t === "key" && r.input.key === "Shift" && !r.input.down,
    ),
  );
  await waitFor(() => screensOf(t, session.id).length === 3);

  const body = await drafted(t, work, call, session.id);
  expect(computer.requests).toContainEqual({ op: "release", taskId: "-2" });
  expect(t.computers.find("m-laptop")?.control).toBe("hatbot");
  expect(t.computers.screen("m-laptop")?.lane.holderId).toBeNull();
  expect(body).toContain('The owner\'s own computer \\"laptop\\", on Linux (niri).');
  expect(body).toContain('window: firefox \\"Account\\" https://library.example/account');
  expect(body).not.toContain("s3cret");
  expect(body).toContain('typed \\"Dune\\"');
  expect(body).toContain("left click at (450, 300)\\n");
  const content = work.creates.find((p) => p.system === TEACH_PROMPT)?.messages[0]?.content as {
    type: string;
    source?: { media_type: string };
  }[];
  expect(content.filter((b) => b.type === "image").map((b) => b.source?.media_type)).toEqual([
    "image/jpeg",
    "image/jpeg",
    "image/jpeg",
  ]);
  const saved = await call("POST", `/teach/${session.id}/save`, {
    name: "renew-books",
    content: SKILL,
  });
  expect(saved.status).toBe(200);

  // Recording it again is on the laptop, where it was shown.
  const again = await call("POST", "/teach/start", { replaces: "renew-books" });
  expect(((await again.json()) as TeachSession).screen).toBe("m-laptop");
  await t.teach.discard(t.teach.current().recording?.id ?? 0);
});

test("Teach on a computer needs its desktop app to know how, and the computer free for Hatbot", async () => {
  const { t, call } = await teachApp();
  const old = await withComputer(t);
  stops.push(old.stop);
  const res = await call("POST", "/teach/start", { screen: "m-laptop" });
  expect(res.status).toBe(503);
  expect(((await res.json()) as { error: string }).error).toBe(
    "Update Hatbot's desktop app on laptop to teach on it.",
  );
  old.stop();
  await waitFor(() => !t.computers.find("m-laptop")?.online);

  const { computer } = teachable();
  stops.push((await withComputer(t, computer)).stop);
  computer.setStatus({ paused: true });
  await waitFor(() => t.computers.find("m-laptop")?.paused);
  expect((await call("POST", "/teach/start", { screen: "m-laptop" })).status).toBe(503);
  expect(computer.requests.some((r) => r.op === "claim")).toBe(false);
  computer.setStatus({ paused: false });
  await waitFor(() => !t.computers.find("m-laptop")?.paused);
  expect((await call("POST", "/teach/start", { screen: "m-laptop" })).status).toBe(200);
});

/** Types `text` with `focus` holding the keyboard, then clicks so the next typing is checked anew. */
async function typeAt(
  rec: Awaited<ReturnType<typeof recordOn>>,
  focus: ComputerField | null,
  text: string,
) {
  rec.at.field = focus;
  await rec.send(typeText(text), { field: 1 });
  await rec.send(click(10, 10), { filled: 1 });
}

test("Teach on a computer: typing where nothing that takes text has the keyboard isn't kept", async () => {
  const { t, work, call } = await teachApp();
  const rec = await recordOn(t, call);
  // PuTTY, an RDP or VNC viewer: UI Automation gives the window's pane.
  await typeAt(rec, field(["PuTTY"], { role: "pane", editable: false }), "r00t-pw-putty");
  // noVNC, or Proxmox's console, in a browser.
  await typeAt(rec, field([], { role: "canvas", editable: false }), "r00t-pw-vnc");
  await typeAt(rec, field(["Search", "q"]), "Dune");
  const body = await drafted(t, work, call, rec.session.id);
  expect(body).not.toContain("r00t-pw");
  expect(body.match(/the field couldn't be checked/g)).toHaveLength(2);
  expect(body).toContain('typed \\"Dune\\"');
});

test("Teach on a computer: typing into a terminal in a page isn't kept", async () => {
  const { t, work, call } = await teachApp();
  const rec = await recordOn(t, call);
  // xterm.js, as in Proxmox's and many web consoles.
  await typeAt(rec, field(["Terminal input"], { role: "entry" }), "r00t-pw-xterm");
  const body = await drafted(t, work, call, rec.session.id);
  expect(body).not.toContain("r00t-pw");
  expect(body).toContain("in a password or code field (not recorded)");
});

const ends: [string, (c: FakeComputer) => void][] = [
  ["Stop on its banner", (c) => c.setStatus({ screen: null })],
  ["pausing it", (c) => c.setStatus({ paused: true })],
  ["turning it off", (c) => c.setStatus({ enabled: false })],
  ["it going offline", (c) => c.close()],
];
for (const [what, end] of ends)
  test(`Teach on a computer: ${what} throws the recording away and frees the computer`, async () => {
    const { t, call } = await teachApp();
    const { computer, session } = await recordOn(t, call);
    end(computer);
    await waitFor(() => t.teach.get(session.id)?.status === "discarded");
    expect(t.teach.current().recording).toBeNull();
    expect(t.computers.find("m-laptop")?.control).toBe("hatbot");
    expect(t.computers.screen("m-laptop")?.lane.holderId).toBeNull();
  });

test("Teach on a computer: input the computer refused isn't recorded", async () => {
  const { t, work, call } = await teachApp();
  const rec = await recordOn(t, call);
  rec.at.field = field(["Search", "q"]);
  rec.computer.answer.live_input = () => ({ error: "The computer is locked.", code: "locked" });
  await rec.send(typeText("zzz"));
  delete rec.computer.answer.live_input;
  await rec.send(typeText("Dune"), { field: 1 });
  const body = await drafted(t, work, call, rec.session.id);
  expect(body).not.toContain("zzz");
  expect(body).toContain('typed \\"Dune\\"');
});
