// A call runs on the plugin as it is when it runs: not as it was when the task started, the reply
// began, or the call was checked or approved.
import { expect, test } from "bun:test";
import { allow, ask, definePlugin, ready, tool } from "@hatbot/plugin-sdk";
import { z } from "zod";
import { FakeModel, text, toolUse } from "./fake-model";
import { type TestApp, testApp, waitFor } from "./helpers";
import { ended, finish, scheduled } from "./plugin-helpers";

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

const restart = (guest: string) => ({ content: [toolUse("guests_restart", { guest })] });

/** A task whose first call waits until `change` has run, as if you changed Settings meanwhile. */
async function changedMidTask(change: (t: TestApp) => Promise<unknown> | unknown) {
  const calls: string[] = [];
  let go = () => {};
  const work = new FakeModel([
    { ...restart("web"), wait: new Promise<void>((r) => (go = r)) },
    finish(),
  ]);
  const t = await testApp(new FakeModel(), work, {}, [guests(calls)]);
  await t.plugins.update("guests", { enabled: true });
  t.settings.update({ reviewChanges: false });
  const task = scheduled(t);
  await waitFor(() => work.requests.length === 1);
  await change(t);
  go();
  return { t, task, calls, result: () => JSON.stringify(work.requests[1]?.messages.at(-1)) };
}

/** The chat, with web careful and no review unless `review` answers it. */
async function chatWith(restarts: string[], calls: string[]) {
  const chat = new FakeModel([...restarts.map(restart), { content: [text("ok")] }]);
  const t = await testApp(chat, new FakeModel(), {}, [guests(calls)]);
  await t.plugins.update("guests", { enabled: true, config: { careful: ["web"] } });
  return { t, chat };
}

test("a call follows the plugin's settings now, in a running task and later in the same reply", async () => {
  const task = await changedMidTask((t) =>
    t.plugins.update("guests", { config: { careful: ["web"] } }),
  );
  const approval = await waitFor(() => task.t.approvals.list(true)[0]);
  expect(approval).toMatchObject({ summary: "Restart web", reason: "web is careful." });
  task.t.approvals.decide(approval.id, "approve", "web");
  await ended(task.t, task.task.id);
  expect(task.calls).toEqual(["web"]);

  const calls: string[] = [];
  const { t } = await chatWith(["web", "db"], calls);
  t.settings.update({ reviewChanges: false });
  const reply = t.thread.post("restart web and db");
  const first = await waitFor(() => t.approvals.list(true)[0]);
  // db is careful too now: the reply's next call asks.
  await t.plugins.update("guests", { config: { careful: ["web", "db"] } });
  t.approvals.decide(first.id, "deny", "web");
  const second = await waitFor(() => t.approvals.list(true)[0]);
  expect(second.summary).toBe("Restart db");
  t.approvals.decide(second.id, "deny", "web");
  await reply.done;
  expect(calls).toEqual([]);
});

test("a task's call isn't run once its plugin is switched off, taken from the bot, or its tool changed", async () => {
  for (const [change, why] of [
    [(t: TestApp) => t.plugins.update("guests", { enabled: false }), "isn't available any more"],
    [(t: TestApp) => t.bots.update("hatbot", { plugins: [] }), "taken from Hatbot"],
    [
      (t: TestApp) => t.plugins.update("guests", { config: { note: " Also wipes its disk." } }),
      "has changed since this task started",
    ],
  ] as const) {
    const { t, task, calls, result } = await changedMidTask(change);
    await ended(t, task.id);
    expect(calls, why).toEqual([]);
    expect(result(), why).toContain(why);
  }
});

test("a plugin restarted while its call waited for approval or the review doesn't run it", async () => {
  // A task's call, approved after its plugin restarted.
  const task = await changedMidTask((t) =>
    t.plugins.update("guests", { config: { careful: ["web"] } }),
  );
  const approval = await waitFor(() => task.t.approvals.list(true)[0]);
  await task.t.plugins.update("guests", { config: { careful: [] } });
  task.t.approvals.decide(approval.id, "approve", "web");
  await ended(task.t, task.task.id);
  expect(task.calls).toEqual([]);
  expect(task.result()).toContain("restarted while this was checked or waited for approval");

  // The chat's, approved after its plugin was switched off.
  const calls: string[] = [];
  const asked = await chatWith(["web"], calls);
  asked.t.settings.update({ reviewChanges: false });
  const reply = asked.t.thread.post("restart web");
  const waiting = await waitFor(() => asked.t.approvals.list(true)[0]);
  await asked.t.plugins.update("guests", { enabled: false });
  asked.t.approvals.decide(waiting.id, "approve", "web");
  await reply.done;

  // The chat's, let through by Haiku's review after its plugin was switched off.
  const reviewed = await chatWith(["web"], calls);
  reviewed.chat.onCreate = (p) => {
    if (!String(p.system).includes("wants to make a change")) return undefined;
    void reviewed.t.plugins.update("guests", { enabled: false });
    return JSON.stringify({ safe: true, why: "A restart." });
  };
  await reviewed.t.thread.post("restart web").done;
  expect(calls).toEqual([]);
  expect(JSON.stringify(reviewed.chat.requests[1]?.messages.at(-1))).toContain("Not run");
});
