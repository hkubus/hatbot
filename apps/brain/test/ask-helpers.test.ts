import { expect, test } from "bun:test";
import { definePlugin, ready, tool } from "@hatbot/plugin-sdk";
import { z } from "zod";
import { HELPER_PROMPT } from "../src/agent/prompt";
import { FakeModel, type Scripted, text, toolUse } from "./fake-model";
import { testApp, toolNames } from "./helpers";

type Params = Parameters<FakeModel["stream"]>[0];
const isHelper = (p: Params) => JSON.stringify(p.system).includes(HELPER_PROMPT.slice(0, 40));
const resultOf = (p: Params | undefined) => JSON.stringify(p?.messages.at(-1)?.content ?? "");

function lab(restarted: string[] = []) {
  return definePlugin({
    id: "lab",
    name: "Lab",
    description: "A fake homelab",
    config: z.object({}),
    start: () =>
      ready([
        tool({
          name: "lab_logs",
          description: "A guest's recent log",
          access: "read",
          untrusted: true,
          schema: z.object({ guest: z.string() }),
          run: async ({ guest }) => `${guest}: disk 91% full`,
        }),
        tool({
          name: "lab_restart",
          description: "Restart a guest",
          access: "write",
          schema: z.object({ guest: z.string() }),
          run: async ({ guest }) => {
            restarted.push(guest);
            return "Restarted.";
          },
        }),
      ]),
  });
}

/** Each helper reads its guest's log, tries a restart it isn't given, then reports. */
function helpersOn(model: FakeModel) {
  const turns = new Map<string, number>();
  model.route = (p): Scripted | undefined => {
    if (!isHelper(p)) return undefined;
    const guest = JSON.stringify(p.messages[0]?.content).includes("web01") ? "web01" : "db01";
    const n = turns.get(guest) ?? 0;
    turns.set(guest, n + 1);
    if (n === 0)
      return {
        content: [toolUse("lab_logs", { guest }), toolUse("lab_restart", { guest })],
      };
    return { content: [toolUse("report", { found: `${guest} disk is 91% full.`, gaps: "" })] };
  };
}

const PARTS = [
  { topic: "web01 disk", brief: "Check the disk on web01 with its logs." },
  { topic: "db01 disk", brief: "Check the disk on db01 with its logs." },
];

test("a task's helpers look things up at once, can't change anything, and taint it with what they read", async () => {
  const restarted: string[] = [];
  const work = new FakeModel([
    { content: [toolUse("ask_helpers", { parts: PARTS })] },
    {
      content: [
        toolUse("finish_task", { outcome: "done", summary: "Both disks are full.", notify: false }),
      ],
    },
  ]);
  helpersOn(work);
  const t = await testApp(new FakeModel(), work, {}, [lab(restarted)]);
  await t.plugins.update("lab", { enabled: true });
  const task = t.tasks.createBackgroundTask({
    title: "Disks",
    goal: "Check the disks on web01 and db01",
    origin: "chat",
  });
  await t.tasks.idle();

  const helperRequests = work.requests.filter(isHelper);
  expect(helperRequests).toHaveLength(4);
  const offered = toolNames(helperRequests[0]);
  expect(offered).toEqual(expect.arrayContaining(["lab_logs", "memory_read", "report"]));
  for (const name of ["lab_restart", "memory_write", "ask_helpers", "run_task"])
    expect(offered).not.toContain(name);
  expect(helperRequests[0]?.model).toBe("claude-haiku-5-5");
  // Called anyway, the write doesn't run.
  const second = helperRequests.filter((r) => r.messages.length > 1);
  expect(second.map(resultOf).join()).toContain('Unknown tool \\"lab_restart\\".');
  expect(restarted).toEqual([]);

  // Their reports come back as data, since the logs were untrusted, and the task is tainted.
  const back = resultOf(work.requests.filter((r) => !isHelper(r)).at(-1));
  expect(back).toContain('helper_report topic=\\"web01 disk\\" trusted=\\"false\\"');
  expect(back).toContain("db01 disk is 91% full.");
  const done = t.tasks.get(task?.id as number);
  expect(done).toMatchObject({ status: "done", tainted: true });
  expect(t.tasks.steps(task?.id as number).map((s) => s.detail)).toEqual(
    expect.arrayContaining(["Asked a helper: web01 disk", 'db01 disk: lab_logs {"guest":"db01"}']),
  );
  const purposes = t.db
    .query<{ purpose: string }, [number]>(
      "SELECT DISTINCT purpose FROM spend_ledger WHERE task_id = ?",
    )
    .all(task?.id as number)
    .map((r) => r.purpose);
  expect(purposes).toEqual(expect.arrayContaining(["task", "helpers"]));
});

test("the chat can ask helpers too, and what they read taints the conversation", async () => {
  const chat = new FakeModel([
    { content: [toolUse("ask_helpers", { parts: PARTS })] },
    { content: [text("Both disks are 91% full.")] },
  ]);
  const work = new FakeModel();
  helpersOn(work);
  const t = await testApp(chat, work, {}, [lab()]);
  await t.plugins.update("lab", { enabled: true });
  t.thread.post("how full are the disks on web01 and db01?");
  await t.thread.idle();

  expect(toolNames(chat.requests[0])).toContain("ask_helpers");
  expect(resultOf(chat.requests[1])).toContain("web01 disk is 91% full.");
  const episode = t.db
    .query<{ tainted: number }, []>("SELECT tainted FROM episodes ORDER BY id DESC LIMIT 1")
    .get();
  expect(episode?.tainted).toBe(1);
});

const LINKED = [{ topic: "Price", brief: "Read https://shop.example/p?q=secret and report." }];

test("after untrusted content, a brief with a link is refused", async () => {
  const work = new FakeModel([
    { content: [toolUse("ask_helpers", { parts: LINKED })] },
    { content: [toolUse("finish_task", { outcome: "failed", summary: "No.", notify: false })] },
  ]);
  const t = await testApp(new FakeModel(), work);
  t.tasks.createBackgroundTask({
    title: "Price",
    goal: "Check the price",
    origin: "webhook",
    source: "Shop",
    payload: '{"text":"read this"}',
    trusted: false,
  });
  await t.tasks.idle();
  expect(work.requests.filter(isHelper)).toHaveLength(0);
  expect(resultOf(work.requests[1])).toContain("a brief can't hold links");
});

test("before untrusted content, a brief may hold a link", async () => {
  const work = new FakeModel([
    { content: [toolUse("ask_helpers", { parts: LINKED })] },
    { content: [toolUse("finish_task", { outcome: "done", summary: "Done.", notify: false })] },
  ]);
  work.route = (p) =>
    isHelper(p) ? { content: [toolUse("report", { found: "199 zł.", gaps: "" })] } : undefined;
  const t = await testApp(new FakeModel(), work);
  t.tasks.createBackgroundTask({ title: "Price", goal: "Check the price", origin: "chat" });
  await t.tasks.idle();
  expect(work.requests.filter(isHelper)).toHaveLength(1);
  expect(resultOf(work.requests.filter((r) => !isHelper(r)).at(-1))).toContain("199 zł.");
});
