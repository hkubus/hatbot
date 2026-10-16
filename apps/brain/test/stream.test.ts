import { expect, test } from "bun:test";
import type { HatbotEvent } from "@hatbot/shared";
import { batchText } from "../src/routes/stream";

test("streamed text goes out together, and before whatever follows it", async () => {
  const sent: HatbotEvent[] = [];
  const batch = batchText((e) => sent.push(e));
  batch.push({ type: "message.delta", id: 1, text: "Hel" });
  batch.push({ type: "task.progress", taskId: 7, text: "Look" });
  batch.push({ type: "message.delta", id: 1, text: "lo" });
  batch.push({ type: "message.progress", id: 1, text: "thinking" });
  batch.push({ type: "task.progress", taskId: 7, text: "ing" });
  expect(sent).toEqual([]);
  await Bun.sleep(80);
  expect(sent).toEqual([
    { type: "message.delta", id: 1, text: "Hello" },
    { type: "task.progress", taskId: 7, text: "Looking" },
    { type: "message.progress", id: 1, text: "thinking" },
  ]);

  sent.length = 0;
  batch.push({ type: "message.delta", id: 2, text: "Done" });
  batch.push({ type: "message.done", id: 2, text: "Done", status: "done" });
  expect(sent.map((e) => e.type)).toEqual(["message.delta", "message.done"]);
  batch.push({ type: "message.delta", id: 3, text: "never" });
  batch.stop();
  await Bun.sleep(80);
  expect(sent).toHaveLength(2);
});
