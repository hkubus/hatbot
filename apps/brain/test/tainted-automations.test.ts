import { expect, test } from "bun:test";
import type { Watcher } from "@hatbot/shared";
import { REVIEW_PROMPT } from "../src/agent/prompt";
import { FakeModel, text, toolUse } from "./fake-model";
import { setUpOwner, type TestApp, testApp, waitFor } from "./helpers";

async function automations(t: TestApp) {
  const schedule = t.schedules.create(
    { name: "Backups", prompt: "Check PBS", cron: "0 9 * * *" },
    "owner",
  );
  t.agent.pages.set("https://example.com/s", "<p>ok</p>");
  const watcher = (await t.watchers.create(
    {
      name: "Status",
      source: { kind: "page", url: "https://example.com/s" },
      condition: { when: "changed" },
      prompt: "",
      everyMinutes: 60,
      once: false,
      enabled: true,
      botId: "hatbot",
    },
    "owner",
  )) as Watcher;
  const trigger = t.triggers.create({ name: "Kuma", kind: "kuma", prompt: "Fix it" });
  return { schedule, watcher, trigger };
}

const taint = (t: TestApp) =>
  t.db.query("UPDATE episodes SET tainted = 1, tainted_by = 'https://evil.example'").run();

test("after reading untrusted content, deleting or switching off an automation asks first", async () => {
  const model = new FakeModel([{ content: [text("hi")] }]);
  const reviews: string[] = [];
  model.onCreate = (p) => {
    if (p.system !== REVIEW_PROMPT) return undefined;
    reviews.push(JSON.stringify(p.messages));
    return JSON.stringify({ safe: false, why: "Nothing you said leads to this." });
  };
  const t = await testApp(model);
  await setUpOwner(t);
  const { schedule, watcher, trigger } = await automations(t);
  await t.thread.post("hello").done;
  taint(t);
  model.script.push(
    { content: [toolUse("schedule_delete", { id: schedule.id })] },
    { content: [toolUse("watch_update", { id: watcher.id, enabled: false })] },
    { content: [toolUse("trigger_update", { id: trigger.id, enabled: false, confirmChecks: 2 })] },
    { content: [toolUse("schedule_update", { id: schedule.id, enabled: false })] },
    { content: [text("Done.")] },
  );
  const reply = t.thread.post("what did that page say?");

  // Deleting the schedule: asked, approved.
  const first = await waitFor(() => t.approvals.list(true)[0]);
  expect(first.summary).toBe(`Delete the schedule #${schedule.id} "Backups"`);
  expect(first.reason).toContain("untrusted content");
  expect(first.reason).toContain("Nothing you said leads to this.");
  expect(first.sources).toEqual(["https://evil.example"]);
  expect(reviews[0]).toContain("schedule_delete");
  expect(t.schedules.get(schedule.id)).not.toBeNull();
  t.approvals.decide(first.id, "approve", "web");

  // Switching the watcher off: denied, so it stays on.
  const second = await waitFor(() => t.approvals.list(true)[0]);
  expect(second.summary).toBe(`Switch off the watcher #${watcher.id} "Status"`);
  t.approvals.decide(second.id, "deny", "web");

  // The trigger: off, and waiting for more checks, in one approval, with a note.
  const third = await waitFor(() => t.approvals.list(true)[0]);
  expect(third.summary).toBe(
    `Change the trigger #${trigger.id} "Kuma": switch it off, and wait for 2 more failed checks`,
  );
  t.approvals.decide(third.id, "approve", "web", "Only for today.");
  await reply.done;

  expect(t.schedules.get(schedule.id)).toBeNull();
  expect(t.watchers.get(watcher.id)?.enabled).toBe(true);
  expect(t.triggers.get(trigger.id)).toMatchObject({ enabled: false, confirmChecks: 2 });
  const results = model.requests.slice(2).map((r) => JSON.stringify(r.messages.at(-1)?.content));
  expect(results[0]).toContain(`Deleted schedule #${schedule.id}.`);
  expect(results[1]).toContain("The owner denied this.");
  expect(results[2]).toContain(`Updated trigger #${trigger.id}`);
  expect(results[2]).toContain("Only for today.");
  // The schedule is gone by then: nothing left to switch off, so nothing asked.
  expect(results[3]).toContain(`No schedule #${schedule.id}.`);
  expect(t.approvals.list(false)).toHaveLength(3);
});

test("an untainted chat deletes and switches off without asking; a tainted one switches on", async () => {
  const model = new FakeModel([
    {
      content: [
        toolUse("watch_delete", { id: 1 }),
        toolUse("trigger_update", { id: 1, enabled: false }),
      ],
    },
    { content: [text("Done.")] },
    { content: [toolUse("schedule_update", { id: 1, enabled: false })] },
    { content: [text("Off.")] },
    { content: [toolUse("schedule_update", { id: 1, enabled: true, name: "PBS" })] },
    { content: [text("On.")] },
  ]);
  const t = await testApp(model);
  await setUpOwner(t);
  const { schedule } = await automations(t);
  await t.thread.post("tidy up").done;
  expect(t.watchers.list()).toEqual([]);
  expect(t.triggers.get(1)?.enabled).toBe(false);
  await t.thread.post("pause the backups check").done;
  expect(t.schedules.get(schedule.id)?.enabled).toBe(false);

  // Switching back on, or renaming, after untrusted content doesn't ask.
  taint(t);
  await t.thread.post("turn it back on").done;
  expect(t.schedules.get(schedule.id)).toMatchObject({ enabled: true, name: "PBS" });
  expect(t.approvals.list(false)).toEqual([]);
});
