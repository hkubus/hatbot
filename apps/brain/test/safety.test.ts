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

/** An untrusted read, a delete that asks, a change on a careful thing, and a plain change. */
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

test("the chat runs as many commands in a reply as Safety lets it", async () => {
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
