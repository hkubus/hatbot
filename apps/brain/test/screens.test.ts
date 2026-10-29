import { afterEach, expect, test } from "bun:test";
import type { StreamParams } from "@hatbot/plugin-sdk";
import { CLICK_CHECK_PROMPT } from "../src/agent/prompt";
import { FakeComputer, withComputer } from "./fake-computer";
import { computer, FakeModel, type Scripted, text, toolUse } from "./fake-model";
import { type TestApp, testApp, waitFor } from "./helpers";
import { ended } from "./plugin-helpers";

const stops: (() => void)[] = [];
afterEach(() => {
  for (const s of stops.splice(0)) s();
});

async function connected(t: TestApp, c?: FakeComputer) {
  const r = await withComputer(t, c);
  stops.push(r.stop);
  return r;
}

const finish = (summary = "Done.") => ({
  content: [toolUse("finish_task", { outcome: "done", summary })],
});

const onComputer = (p: Omit<StreamParams, "stream">) =>
  JSON.stringify(p.system).includes("their own Linux computer");

const startOn = (t: TestApp, screen: string | null, goal = "Tidy the downloads") =>
  t.tasks.createDesktopTask({ title: goal, goal, successCriteria: "", origin: "chat", screen });

test("a chat starts a task on the owner's computer: using it is asked once, naming it; when the owner takes the mouse it waits, then carries on", async () => {
  const chat = new FakeModel([
    {
      content: [
        toolUse("run_desktop_task", {
          title: "Tidy downloads",
          goal: "Tidy my downloads",
          success_criteria: "",
          screen: "Laptop",
        }),
      ],
    },
    { content: [text("Started it.")] },
    { content: [text("Done.")] },
  ]);
  const work = new FakeModel([
    { content: [computer("left_click", { coordinate: [10, 20] })] },
    { content: [computer("left_click", { coordinate: [30, 40] })] },
    { content: [computer("screenshot")] },
    finish(),
  ]);
  work.onCreate = (p) =>
    p.system === CLICK_CHECK_PROMPT ? '{"consequential": false, "label": ""}' : undefined;
  const t = await testApp(chat, work);
  const { computer: laptop } = await connected(t);
  let clicks = 0;
  laptop.answer.action = () => {
    // The owner grabs the mouse as the first click goes.
    if (clicks++ > 0) return { op: "action", result: {} };
    laptop.setStatus({ ownerActive: true });
    return { error: "You're using it.", code: "owner" };
  };

  t.thread.post("tidy my downloads on my laptop");
  const approval = await waitFor(() => t.approvals.list(true)[0]);
  expect(approval).toMatchObject({ kind: "computer" });
  expect(approval.summary).toContain("laptop");
  const task = t.tasks.list({ status: "active" })[0];
  expect(task?.screen).toBe("m-laptop");
  t.approvals.decide(approval.id, "approve", "web");

  await waitFor(() =>
    t.tasks.steps(task?.id as number).find((s) => s.name === "Waiting: laptop is in use by you"),
  );
  expect(t.tasks.get(task?.id as number)?.status).toBe("queued");
  laptop.setStatus({ ownerActive: false });

  const done = await ended(t, task?.id as number);
  expect(done).toMatchObject({ status: "done", tainted: true });
  expect(t.approvals.list(false).filter((a) => a.taskId === done.id)).toHaveLength(1);
  expect(onComputer(work.requests[0] as Omit<StreamParams, "stream">)).toBe(true);
  expect(work.requests[0]?.tools?.some((x) => "name" in x && x.name === "desktop_shell")).toBe(
    false,
  );
  expect(clicks).toBe(2);
  expect(laptop.requests.map((r) => r.op)).toContain("claim");
  await waitFor(() => laptop.requests.at(-1)?.op === "release");
  // The guest's desktop wasn't touched.
  expect(t.agent.actions).toEqual([]);
});

test("the desktop and a computer each run a task at once", async () => {
  const { promise: hold, resolve: go } = Promise.withResolvers<void>();
  const guestScript: Scripted[] = [{ content: [computer("screenshot")] }, finish()];
  const laptopScript: Scripted[] = [{ content: [computer("screenshot")], wait: hold }, finish()];
  const work = new FakeModel();
  work.route = (p) => (onComputer(p) ? laptopScript : guestScript).shift();
  const t = await testApp(new FakeModel(), work);
  await connected(t);

  const there = startOn(t, "m-laptop");
  t.approvals.decide((await waitFor(() => t.approvals.list(true)[0])).id, "approve", "web");
  await waitFor(() => work.requests.some(onComputer));
  // The laptop's task holds its screen while its model thinks; the desktop's runs to the end.
  const here = startOn(t, null, "Check the weather");
  expect((await ended(t, here.id)).status).toBe("done");
  expect(t.tasks.get(there.id)?.status).toBe("running");
  go();
  expect((await ended(t, there.id)).status).toBe("done");
});

test("a computer that doesn't let tasks use it fails the task without asking; an unknown one isn't started", async () => {
  const t = await testApp();
  await connected(
    t,
    new FakeComputer({
      machineId: "m-laptop",
      name: "laptop",
      version: "test",
      compositor: "niri",
      enabled: false,
      features: ["screen", "input"],
    }),
  );
  const task = startOn(t, "m-laptop");
  expect((await ended(t, task.id)).status).toBe("failed");
  expect(t.approvals.list(false)).toEqual([]);

  expect(t.tasks.screenFor("laptop")).toEqual({ screen: "m-laptop" });
  expect("error" in t.tasks.screenFor("desk")).toBe(true);
});

test("on a computer, a click nothing can name is judged from a zoomed screenshot: consequential ones wait for confirm_intent", async () => {
  const click = () => computer("left_click", { coordinate: [300, 500] });
  const work = new FakeModel([{ content: [click()] }, { content: [click()] }, finish()]);
  const verdicts = [
    '{"consequential": true, "label": "Delete forever"}',
    '{"consequential": false, "label": "Open"}',
  ];
  work.onCreate = (p) => (p.system === CLICK_CHECK_PROMPT ? verdicts.shift() : undefined);
  const t = await testApp(new FakeModel(), work);
  const { computer: laptop } = await connected(t);
  const task = startOn(t, "m-laptop");
  t.approvals.decide((await waitFor(() => t.approvals.list(true)[0])).id, "approve", "web");
  await ended(t, task.id);

  expect(JSON.stringify(work.requests[1]?.messages.at(-1)?.content)).toContain("Delete forever");
  expect(laptop.requests.filter((r) => r.op === "zoom")).toHaveLength(2);
  expect(laptop.requests.filter((r) => r.op === "action")).toHaveLength(1);
});
