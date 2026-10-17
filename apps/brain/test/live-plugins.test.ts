import { expect, test } from "bun:test";
import type { Task } from "@hatbot/shared";
import { z } from "zod";
import { allow, ask, definePlugin, ready, tool } from "../src/plugins/plugin";
import { FakeModel, text, toolUse } from "./fake-model";
import { type TestApp, testApp, waitFor } from "./helpers";

/** Restarts guests; the careful ones ask first. `note` is part of the tool's description. */
function guests(calls: string[]) {
  return definePlugin({
    id: "guests",
    name: "Guests",
    description: "",
    config: z.object({
      careful: z.array(z.string()).default([]),
      note: z.string().default(""),
    }),
    start: ({ config }) =>
      ready([
        tool({
          name: "guests_restart",
          description: `Restart a guest.${config.note}`,
          access: "write",
          schema: z.object({ guest: z.string() }),
          describe: ({ guest }) => `Restart ${guest}`,
          policy: ({ guest }) =>
            config.careful.includes(guest) ? ask(`${guest} is careful.`) : allow(),
          run: async ({ guest }) => {
            calls.push(guest);
            return `Restarted ${guest}.`;
          },
        }),
      ]),
  });
}

/** A task whose first call waits until `change` has run, as if you changed Settings meanwhile. */
async function changedMidTask(change: (t: TestApp) => Promise<unknown> | unknown) {
  const calls: string[] = [];
  let go = () => {};
  const work = new FakeModel([
    {
      content: [toolUse("guests_restart", { guest: "web" })],
      wait: new Promise<void>((r) => {
        go = r;
      }),
    },
    { content: [toolUse("finish_task", { outcome: "done", summary: "Done.", notify: false })] },
  ]);
  const t = await testApp(new FakeModel(), work, {}, [guests(calls)]);
  await t.plugins.update("guests", { enabled: true });
  const task = t.tasks.createBackgroundTask({
    title: "Restart web",
    goal: "Restart web",
    origin: "schedule",
    source: "nightly",
    runKey: "schedule:1",
  }) as Task;
  await waitFor(() => work.requests.length === 1);
  // Offered when it started.
  expect(JSON.stringify(work.requests[0]?.tools)).toContain("guests_restart");
  await change(t);
  go();
  return { t, task, work, calls };
}

const resultOf = (work: FakeModel) => JSON.stringify(work.requests[1]?.messages.at(-1)?.content);

test("a running task's call follows the plugin's settings now, not when it started", async () => {
  const { t, task, calls } = await changedMidTask((t) =>
    t.plugins.update("guests", { config: { careful: ["web"] } }),
  );
  const approval = await waitFor(() => t.approvals.list(true)[0]);
  expect(approval).toMatchObject({ summary: "Restart web", reason: "web is careful." });
  expect(calls).toEqual([]);
  t.approvals.decide(approval.id, "approve", "web");
  await waitFor(() => t.tasks.get(task.id)?.finishedAt);
  expect(calls).toEqual(["web"]);
});

test("a plugin switched off, or taken from the bot, mid-task refuses the call", async () => {
  const off = await changedMidTask((t) => t.plugins.update("guests", { enabled: false }));
  await waitFor(() => off.t.tasks.get(off.task.id)?.finishedAt);
  expect(off.calls).toEqual([]);
  expect(resultOf(off.work)).toContain("guests_restart isn't available any more");
  expect(off.t.tasks.steps(off.task.id).some((s) => s.name === "Refused")).toBe(true);

  const taken = await changedMidTask((t) => t.bots.update("hatbot", { plugins: [] }));
  await waitFor(() => taken.t.tasks.get(taken.task.id)?.finishedAt);
  expect(taken.calls).toEqual([]);
  expect(resultOf(taken.work)).toContain("taken from Hatbot");
});

test("a tool whose description changed mid-task isn't run on the old one", async () => {
  const { t, task, work, calls } = await changedMidTask((t) =>
    t.plugins.update("guests", { config: { note: " Also wipes its disk." } }),
  );
  await waitFor(() => t.tasks.get(task.id)?.finishedAt);
  expect(calls).toEqual([]);
  expect(resultOf(work)).toContain("guests_restart has changed since this task started");
});

test("in the chat, a plugin switched off while a change waited for approval doesn't run it", async () => {
  const calls: string[] = [];
  const chat = new FakeModel([
    { content: [toolUse("guests_restart", { guest: "web" })] },
    { content: [text("It didn't run.")] },
  ]);
  const t = await testApp(chat, new FakeModel(), {}, [guests(calls)]);
  await t.plugins.update("guests", { enabled: true, config: { careful: ["web"] } });
  t.settings.update({ reviewChanges: false });
  const reply = t.thread.post("restart web");
  const approval = await waitFor(() => t.approvals.list(true)[0]);
  await t.plugins.update("guests", { enabled: false });
  t.approvals.decide(approval.id, "approve", "web");
  await reply.done;
  expect(calls).toEqual([]);
  expect(JSON.stringify(chat.requests[1]?.messages.at(-1)?.content)).toContain(
    "switched off or restarted while this was checked or waited for approval",
  );
});

test("a plugin restarted while its call waited for approval doesn't run the approved call", async () => {
  const { t, task, work, calls } = await changedMidTask((t) =>
    t.plugins.update("guests", { config: { careful: ["web"] } }),
  );
  const approval = await waitFor(() => t.approvals.list(true)[0]);
  await t.plugins.update("guests", { config: { careful: [] } });
  t.approvals.decide(approval.id, "approve", "web");
  await waitFor(() => t.tasks.get(task.id)?.finishedAt);
  expect(calls).toEqual([]);
  expect(resultOf(work)).toContain("restarted while this was checked or waited for approval");
});

test("in the chat, each call in a reply runs on the plugin as it is now", async () => {
  const calls: string[] = [];
  const chat = new FakeModel([
    { content: [toolUse("guests_restart", { guest: "web" })] },
    { content: [toolUse("guests_restart", { guest: "db" })] },
    { content: [text("ok")] },
  ]);
  const t = await testApp(chat, new FakeModel(), {}, [guests(calls)]);
  await t.plugins.update("guests", { enabled: true, config: { careful: ["web"] } });
  t.settings.update({ reviewChanges: false });
  const reply = t.thread.post("restart web and db");
  const first = await waitFor(() => t.approvals.list(true)[0]);
  // db is careful too now: the reply's next call asks.
  await t.plugins.update("guests", { config: { careful: ["web", "db"] } });
  t.approvals.decide(first.id, "deny", "web");
  const second = await waitFor(() => t.approvals.list(true)[0]);
  expect(second.summary).toBe("Restart db");
  // Switched off meanwhile: the approved call doesn't run.
  await t.plugins.update("guests", { enabled: false });
  t.approvals.decide(second.id, "approve", "web");
  await reply.done;
  expect(calls).toEqual([]);
});

test("a plugin switched off while Haiku reviewed the call doesn't run it", async () => {
  const calls: string[] = [];
  let app: TestApp | null = null;
  const review = (p: { system?: unknown }) => {
    if (!String(p.system).includes("wants to make a change")) return undefined;
    void app?.plugins.update("guests", { enabled: false });
    return JSON.stringify({ safe: true, why: "A restart." });
  };
  // The chat.
  const chat = new FakeModel([
    { content: [toolUse("guests_restart", { guest: "web" })] },
    { content: [text("ok")] },
  ]);
  chat.onCreate = review;
  const t = await testApp(chat, new FakeModel(), {}, [guests(calls)]);
  app = t;
  await t.plugins.update("guests", { enabled: true, config: { careful: ["web"] } });
  await t.thread.post("restart web").done;
  expect(calls).toEqual([]);
  expect(JSON.stringify(chat.requests[1]?.messages.at(-1)?.content)).toContain("Not run");

  // A task.
  const {
    t: u,
    task,
    work,
  } = await changedMidTask((u) => {
    app = u;
    return u.plugins.update("guests", { config: { careful: ["web"] } });
  });
  work.onCreate = review;
  await waitFor(() => u.tasks.get(task.id)?.finishedAt);
  expect(calls).toEqual([]);
  expect(resultOf(work)).toContain("Not run");
});
