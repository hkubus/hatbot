import { expect, test } from "bun:test";
import { definePlugin, ready, tool } from "@hatbot/plugin-sdk";
import { z } from "zod";
import { FakeModel, text, toolUse } from "./fake-model";
import { testApp, toolNames } from "./helpers";

const lab = definePlugin({
  id: "lab",
  name: "Lab",
  description: "A fake homelab",
  config: z.object({}),
  start: () =>
    ready([
      tool({
        name: "lab_status",
        description: "Guest status",
        access: "read",
        schema: z.object({}),
        run: async () => "All running.",
      }),
      tool({
        name: "lab_restart",
        description: "Restart a guest",
        access: "write",
        schema: z.object({ guest: z.string() }),
        run: async () => "Restarted.",
      }),
    ]),
});

test("hatbot_about tells a bot how Hatbot works and how it's set up now", async () => {
  const chat = new FakeModel([
    { content: [toolUse("hatbot_about", {})] },
    { content: [text("Money, accounts and doors ask you.")] },
  ]);
  const t = await testApp(chat, new FakeModel(), {}, [lab]);
  await t.plugins.update("lab", { enabled: true });
  t.settings.update({
    safety: { ...t.settings.get().safety, tools: { lab_restart: "ask" } },
  });
  t.thread.post("what keeps you from doing something dangerous?");
  await t.thread.idle();

  expect(toolNames(chat.requests[0])).toContain("hatbot_about");
  const about = JSON.stringify(chat.requests[1]?.messages.at(-1)?.content);
  expect(about).toContain("hatbot-pct-exec");
  expect(about).toContain("Not paused.");
  expect(about).toContain("purchases asks you");
  expect(about).toContain("lab_restart always asks");
  expect(about).toContain("- Lab: A fake homelab\\n  Looks: lab_status\\n  Changes: lab_restart");
});

test("a research task can read hatbot_about", async () => {
  const work = new FakeModel([
    {
      content: [
        toolUse("finish_research", { outcome: "failed", answer: "No.", report: "", notify: false }),
      ],
    },
  ]);
  const t = await testApp(new FakeModel(), work);
  t.tasks.createBackgroundTask({
    title: "How safe is Hatbot",
    goal: "Compare Hatbot's safety with other agents",
    origin: "chat",
    runner: "research",
  });
  await t.tasks.idle();
  expect(toolNames(work.requests[0])).toContain("hatbot_about");
});
