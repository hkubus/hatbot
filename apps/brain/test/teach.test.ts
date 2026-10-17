import { expect, test } from "bun:test";
import type { TeachSession } from "@hatbot/shared";
import type { LiveInput } from "@hatbot/shared/desktop";
import { TEACH_PROMPT } from "../src/agent/prompt";
import { HATBOT } from "../src/memory/store";
import { describeSteps, Recorder } from "../src/teach/recorder";
import { describeSkill, withSkillsSection } from "../src/teach/skills";
import { FakeModel, text, toolUse } from "./fake-model";
import { setUpOwner, type TestApp, testApp, waitFor } from "./helpers";

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

function recorder(secret: () => Promise<boolean> = async () => false) {
  let now = 0;
  let shots = 0;
  const r = new Recorder({
    clock: () => now,
    secretField: secret,
    snap: async (label) => `screens/teach/${++shots}-${label}.webp`,
  });
  return { r, tick: (ms: number) => (now += ms) };
}

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
  return { t, work, call };
}

type Call = (method: string, path: string, body?: unknown) => Response | Promise<Response>;

async function record(t: TestApp, call: Call) {
  const res = await call("POST", "/teach/start");
  expect(res.status).toBe(200);
  const session = (await res.json()) as TeachSession;
  expect(session.status).toBe("recording");
  for (const m of click(400, 300)) t.teach.input(m);
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
  const images = content.filter((b) => b.type === "image");
  expect(images).toHaveLength(3);
  expect(t.db.query("SELECT purpose FROM spend_ledger").all()).toContainEqual({
    purpose: "teach",
  });

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
  const call = (method: string, path: string) => t.call(method, path, undefined, { cookie });
  const task = t.tasks.createDesktopTask({
    title: "Log in",
    goal: "Log in",
    successCriteria: "",
    origin: "chat",
  });
  await waitFor(() => t.tasks.get(task.id)?.status === "waiting_takeover");
  const busy = await call("POST", "/teach/start");
  expect(busy.status).toBe(409);
  await t.tasks.cancel(task.id);
  await t.tasks.idle();

  await call("POST", "/teach/start");
  const stopped = (await (await call("POST", "/teach/stop")).json()) as TeachSession;
  expect(stopped.status).toBe("failed");
  expect(stopped.error).toContain("Nothing was recorded");
  expect((await call("POST", `/teach/${stopped.id}/draft`)).status).toBe(409);
  expect((await call("GET", "/teach")).status).toBe(200);
  expect((await t.call("POST", "/teach/start")).status).toBe(401);
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
