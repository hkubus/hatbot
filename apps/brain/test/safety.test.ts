// Settings → Safety: what asks you, what the review answers, and what goes ahead.
import { expect, test } from "bun:test";
import { ask, askCareful, definePlugin, ready, tool } from "@hatbot/plugin-sdk";
import { z } from "zod";
import { REVIEW_PROMPT } from "../src/agent/prompt";
import { FakeModel, text, toolUse } from "./fake-model";
import { signIn, type TestApp, testApp, waitFor } from "./helpers";

const finish = {
  content: [toolUse("finish_task", { outcome: "done", summary: "Done.", notify: false })],
};
const call = (name: string, input: object = {}) => ({ content: [toolUse(name, input)] });

/**
 * An untrusted read, a delete that asks, a change on a careful thing, a plain change, and an upgrade
 * on a guest, whose output is untrusted.
 */
function labPlugin(done: string[]) {
  const write = (name: string, policy?: () => ReturnType<typeof ask>) =>
    tool({
      name,
      description: "",
      access: "write",
      schema: z.object({}),
      policy,
      run: async () => {
        done.push(name);
        return "Done.";
      },
    });
  return definePlugin({
    id: "lab",
    name: "Lab",
    description: "",
    config: z.object({}),
    start: () =>
      ready([
        tool({
          name: "lab_issue",
          description: "",
          access: "read",
          schema: z.object({}),
          untrusted: true,
          run: async () => "Issue #4: the web service is slow.",
        }),
        write("lab_wipe", () => ask("It deletes the logs.", "delete")),
        write("lab_door", () => askCareful("The owner asked to approve changes to it.")),
        write("lab_restart"),
        tool({
          name: "lab_upgrade",
          description: "",
          access: "write",
          schema: z.object({ guest: z.string() }),
          describe: ({ guest }) => `Upgrade ${guest}`,
          target: ({ guest }) => guest,
          untrusted: true,
          run: async ({ guest }) => {
            done.push(`upgrade ${guest}`);
            return "Upgraded.";
          },
        }),
      ]),
  });
}

/** Haiku's review lets everything through, so only what doesn't reach it asks. */
const reviewSaysSafe = (p: { system?: unknown }) =>
  p.system === REVIEW_PROMPT ? '{"safe": true, "why": "Routine."}' : undefined;

async function lab(steps: ReturnType<typeof call>[]) {
  const done: string[] = [];
  const work = new FakeModel(steps);
  work.onCreate = reviewSaysSafe;
  const t = await testApp(new FakeModel(), work, {}, [labPlugin(done)]);
  await t.plugins.update("lab", { enabled: true });
  return { t, done, work };
}

const runTask = (t: TestApp) =>
  t.tasks.createBackgroundTask({ title: "Fix", goal: "Fix it", origin: "chat" })?.id ?? 0;
const finished = (t: TestApp, id: number) => waitFor(() => t.tasks.get(id)?.finishedAt);
const reviewed = (m: FakeModel) => m.creates.some((c) => c.system === REVIEW_PROMPT);

test("Safety settings save one kind at a time and refuse a level that isn't one", async () => {
  const { t } = await lab([]);
  const { cookie } = signIn(t);
  const put = (body: object) => t.call("PUT", "/settings", body, { cookie });
  expect((await put({ safety: { kinds: { delete: "allow" } } })).status).toBe(200);
  expect((await put({ safety: { chatCommands: 5 } })).status).toBe(200);
  expect(t.settings.get().safety).toMatchObject({
    kinds: { delete: "allow", payment: "ask", other: "review" },
    chatCommands: 5,
    untrusted: true,
  });
  expect((await put({ safety: { kinds: { payment: "sometimes" } } })).status).toBe(400);
});

test("a kind set to go ahead runs without asking; one set to ask skips the review", async () => {
  const { t, done, work } = await lab([call("lab_wipe"), finish, call("lab_wipe"), finish]);
  t.settings.update({ safety: { kinds: { delete: "allow" } } });
  await finished(t, runTask(t));
  expect(done).toEqual(["lab_wipe"]);
  expect(t.approvals.list(false)).toEqual([]);
  expect(reviewed(work)).toBe(false);

  t.settings.update({ safety: { kinds: { delete: "ask" } } });
  const id = runTask(t);
  const asked = await waitFor(() => t.approvals.list(true)[0]);
  expect(asked.kind).toBe("delete");
  expect(reviewed(work)).toBe(false);
  t.approvals.decide(asked.id, "approve", "web");
  await finished(t, id);
  expect(done).toEqual(["lab_wipe", "lab_wipe"]);
});

test("with the untrusted rule off, a tainted task's change runs; a policy's own ask still asks", async () => {
  const { t, done } = await lab([call("lab_issue"), call("lab_restart"), call("lab_wipe"), finish]);
  t.settings.update({ reviewChanges: false, safety: { untrusted: false } });
  const id = runTask(t);
  const asked = await waitFor(() => t.approvals.list(true)[0]);
  expect(t.tasks.get(id)?.tainted).toBe(true);
  expect(done).toEqual(["lab_restart"]);
  expect(asked.summary).toContain("lab_wipe");
  t.approvals.decide(asked.id, "approve", "web");
  await finished(t, id);
  expect(done).toEqual(["lab_restart", "lab_wipe"]);
});

test("a tool set to never ask runs after untrusted content; one set to always ask gets past the review to you", async () => {
  const { t, done, work } = await lab([
    call("lab_issue"),
    call("lab_restart"),
    call("lab_wipe"),
    finish,
  ]);
  t.settings.update({ safety: { tools: { lab_restart: "allow", lab_wipe: "ask" } } });
  const id = runTask(t);
  const asked = await waitFor(() => t.approvals.list(true)[0]);
  expect(done).toEqual(["lab_restart"]);
  expect(asked.summary).toContain("lab_wipe");
  expect(asked.scopes).toEqual([]);
  expect(reviewed(work)).toBe(false);
  t.approvals.decide(asked.id, "approve", "web");
  await finished(t, id);
});

test("what you marked careful asks you whatever Safety allows", async () => {
  const { t, done } = await lab([call("lab_door"), finish]);
  t.settings.update({
    safety: { tools: { lab_door: "allow" }, untrusted: false, kinds: { other: "allow" } },
  });
  const id = runTask(t);
  const asked = await waitFor(() => t.approvals.list(true)[0]);
  expect(done).toEqual([]);
  t.approvals.decide(asked.id, "deny", "web");
  await finished(t, id);
  expect(done).toEqual([]);
});

test("the chat runs as many commands in a reply as Safety lets it, and is told how many", async () => {
  const done: string[] = [];
  const restarts = { content: [1, 2, 3].map(() => toolUse("lab_restart", {})) };
  const chat = new FakeModel([restarts, { content: [text("Done.")] }]);
  const t = await testApp(chat, new FakeModel(), {}, [labPlugin(done)]);
  await t.plugins.update("lab", { enabled: true });
  await t.thread.post("restart it three times").done;
  expect(done).toHaveLength(2);

  chat.script.push(restarts, { content: [text("Done.")] });
  t.settings.update({ safety: { chatCommands: 3 } });
  await t.thread.post("again").done;
  expect(done).toHaveLength(5);
  expect(JSON.stringify(chat.requests.at(-1)?.system)).toContain("at most 3 commands");
});

const reviewSaysUnsafe = (p: { system?: unknown }) =>
  p.system === REVIEW_PROMPT
    ? '{"safe": false, "why": "Nothing you said asks for it."}'
    : undefined;

test("the review blocks a task's change without asking; Run anyway lets the running task do it once", async () => {
  const { t, done, work } = await lab([
    call("lab_wipe"),
    call("wait", { minutes: 5, for: "the owner" }),
    call("lab_wipe"),
    finish,
  ]);
  work.onCreate = reviewSaysUnsafe;
  const id = runTask(t);
  const blocked = await waitFor(() => t.approvals.list(true)[0]);
  expect(blocked).toMatchObject({ status: "blocked", taskId: id, scopes: ["always"] });
  expect(t.tasks.get(id)?.status).toBe("running");
  const { cookie } = signIn(t);
  expect((await t.call("POST", `/approvals/${blocked.id}/anyway`, {}, { cookie })).status).toBe(
    200,
  );
  await finished(t, id);
  expect(done).toEqual(["lab_wipe"]);
  expect(t.tasks.get(id)?.status).toBe("done");
  expect(t.tasks.list({})).toHaveLength(1);
});

test("Run anyway on a task that has ended goes on in a new run, which makes the same call; another of its blocks goes to that run", async () => {
  const { t, done, work } = await lab([
    call("lab_issue"),
    call("lab_wipe"),
    call("lab_restart"),
    finish,
    call("lab_wipe"),
    call("wait", { minutes: 5, for: "the owner" }),
    call("lab_restart"),
    finish,
  ]);
  work.onCreate = reviewSaysUnsafe;
  const id = runTask(t);
  await finished(t, id);
  expect(done).toEqual([]);
  const [restart, wipe] = t.approvals.list(true);
  const { cookie } = signIn(t);
  const anyway = (a?: { id: number }) =>
    t.call("POST", `/approvals/${a?.id}/anyway`, {}, { cookie });
  expect((await anyway(wipe)).status).toBe(200);
  await waitFor(() => done.length === 1);
  expect((await anyway(restart)).status).toBe(200);
  const [next] = t.tasks.list({}).filter((task) => task.id !== id);
  await finished(t, next?.id ?? 0);
  expect(done).toEqual(["lab_wipe", "lab_restart"]);
  expect(t.tasks.list({})).toHaveLength(2);
  expect(t.tasks.get(next?.id ?? 0)).toMatchObject({ status: "done", tainted: true });
  const used = t.db
    .query<{ used_at: string | null }, []>("SELECT used_at FROM approvals ORDER BY id")
    .all();
  expect(used.every((a) => a.used_at)).toBe(true);
});

test("a task's question and the owner's answer reach the review as the owner's words", async () => {
  const asks = {
    content: [toolUse("ask_owner", { questions: [{ question: "Restart the web service?" }] })],
  };
  const { t, done, work } = await lab([call("lab_issue"), asks, call("lab_restart"), finish]);
  const id = runTask(t);
  const question = await waitFor(() => t.questions.pending()[0]);
  t.questions.answer(question.id, "Yes, restart it");
  await finished(t, id);
  expect(done).toEqual(["lab_restart"]);
  const review = work.creates.find((c) => c.system === REVIEW_PROMPT);
  const ownerSaid = String(review?.messages[0]?.content).split("</owner_said>")[0] ?? "";
  expect(ownerSaid).toContain("Restart the web service?");
  expect(ownerSaid).toContain("Yes, restart it");
});

test("a task stops after the review blocks three changes in a row, and a review that fails blocks", async () => {
  const { t, done, work } = await lab([
    call("lab_wipe"),
    call("lab_wipe"),
    call("lab_wipe"),
    finish,
  ]);
  work.onCreate = (p) => (p.system === REVIEW_PROMPT ? "not json" : undefined);
  const id = runTask(t);
  await finished(t, id);
  expect(done).toEqual([]);
  expect(t.tasks.get(id)).toMatchObject({ status: "failed" });
  expect(t.tasks.get(id)?.summary).toContain("blocked 3 changes in a row");
  expect(t.approvals.list(true).map((a) => a.status)).toEqual(["blocked", "blocked", "blocked"]);
  expect(t.approvals.list(true)[0]?.reason).toContain("it couldn't be checked");
});

// Task 743 upgraded 21 containers one at a time, each reviewed, for 53 minutes.
test("a step's reviewed changes on different guests are all checked before any runs, each seeing the others, and its blocks count once", async () => {
  const upgrades = (guests: string[]) => ({
    content: guests.map((guest) => toolUse("lab_upgrade", { guest })),
  });
  const { t, done, work } = await lab([
    upgrades(["a", "b", "c", "d"]),
    upgrades(["b", "c", "d"]),
    finish,
  ]);
  let reviews = 0;
  work.onCreate = (p) => {
    if (p.system !== REVIEW_PROMPT) return undefined;
    done.push("review");
    // Once a's output has tainted the task, the first step's others are blocked, by Haiku and Opus.
    return ++reviews <= 6 ? '{"safe": false, "why": "No."}' : '{"safe": true, "why": "Asked."}';
  };
  const id = runTask(t);
  await finished(t, id);
  expect(t.tasks.get(id)?.status).toBe("done");
  expect(done.slice(0, 10)).toEqual(["upgrade a", ...Array(9).fill("review")]);
  expect(done.slice(10).sort()).toEqual(["upgrade b", "upgrade c", "upgrade d"]);
  const asked = work.creates.filter((c) => c.system === REVIEW_PROMPT).at(-1);
  const content = String(asked?.messages[0]?.content);
  const action = ["b", "c", "d"].find((g) => content.includes(`"summary":"Upgrade ${g}"`));
  expect(action).toBeDefined();
  for (const g of ["b", "c", "d"].filter((g) => g !== action))
    expect(content.split("</changes_alongside>")[0]).toContain(`Upgrade ${g}`);
});

test("Always on a blocked change lets that exact call skip the review from then on", async () => {
  const { t, done, work } = await lab([call("lab_wipe"), finish, call("lab_wipe"), finish]);
  work.onCreate = reviewSaysUnsafe;
  await finished(t, runTask(t));
  const [blocked] = t.approvals.list(true);
  t.approvals.runAnyway(blocked?.id ?? 0, true);
  expect(t.approvals.rules()).toHaveLength(1);
  await finished(t, runTask(t));
  expect(done).toEqual(["lab_wipe"]);
});
