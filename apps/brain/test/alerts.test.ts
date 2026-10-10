import { expect, test } from "bun:test";
import type { Task } from "@hatbot/shared";
import { z } from "zod";
import { definePlugin, ready, tool } from "../src/plugins/plugin";
import { FakeModel, toolUse } from "./fake-model";
import { type TestApp, testApp, waitFor } from "./helpers";

const down = { heartbeat: { status: 0, msg: "timeout" }, monitor: { id: 3, name: "Jellyfin" } };
const up = { heartbeat: { status: 1, msg: "200 OK" }, monitor: { id: 3, name: "Jellyfin" } };

test("a Kuma alert: the task investigates, restarts, and hears that the monitor is back", async () => {
  let app: TestApp | null = null;
  let triggerId = 0;
  const restarted: string[] = [];
  // Restarting brings the monitor back: Kuma says so while the task is still running.
  const lab = definePlugin({
    id: "lab",
    name: "Lab",
    description: "",
    config: z.object({}),
    start: () =>
      ready([
        tool({
          name: "lab_logs",
          description: "",
          access: "read",
          schema: z.object({}),
          run: async () => "jellyfin: out of memory, killed",
        }),
        tool({
          name: "lab_restart",
          description: "",
          access: "write",
          schema: z.object({ service: z.string() }),
          run: async ({ service }) => {
            restarted.push(service);
            app?.triggers.receiveKuma(triggerId, up);
            return `Restarted ${service}.`;
          },
        }),
      ]),
  });
  const work = new FakeModel([
    { content: [toolUse("lab_logs", {})] },
    { content: [toolUse("lab_restart", { service: "jellyfin" })] },
    {
      content: [
        toolUse("finish_task", {
          outcome: "done",
          summary: "Jellyfin ran out of memory; restarted it and it's back.",
          notify: true,
        }),
      ],
    },
  ]);
  const t = await testApp(new FakeModel(), work, {}, [lab]);
  app = t;
  await t.plugins.update("lab", { enabled: true });
  triggerId = t.triggers.create({ name: "Kuma", kind: "kuma", prompt: "Fix it" }).id;

  const r = t.triggers.receiveKuma(triggerId, down);
  expect(r.status).toBe("started");
  const task = (r as { task: Task }).task;
  await waitFor(() => t.tasks.get(task.id)?.finishedAt);

  expect(restarted).toEqual(["jellyfin"]);
  // The alert task got the plugin tools, and the "back up" event arrived with the restart's result.
  expect(work.requests[0]?.tools?.map((x) => (x as { name: string }).name)).toContain(
    "lab_restart",
  );
  const after = JSON.stringify(work.requests[2]?.messages.at(-1));
  expect(after).toContain("Restarted jellyfin.");
  expect(after).toContain('<event trusted=\\"true\\">');
  expect(after).toContain("is back up");
  expect(t.tasks.steps(task.id).some((s) => s.name === "Jellyfin is back up")).toBe(true);
  expect(t.notifier.sent.at(-1)?.title).toBe("Done: Jellyfin is down");
});

test("code tasks get more room than routine ones", async () => {
  const work = new FakeModel([
    { content: [toolUse("finish_task", { outcome: "done", summary: "PR opened.", notify: true })] },
  ]);
  const t = await testApp(new FakeModel(), work);
  t.tasks.createBackgroundTask({ title: "Fix CI", goal: "Fix it", origin: "chat", effort: "high" });
  await t.tasks.idle();
  expect(work.requests[0]?.max_tokens).toBe(32000);
  expect(work.requests[0]?.output_config?.effort).toBe("high");
});
