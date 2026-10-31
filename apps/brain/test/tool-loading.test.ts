// A tool the bot can't use isn't sent: what's sent is billed on every cold cache.
import { expect, test } from "bun:test";
import { FakeModel, text } from "./fake-model";
import { testApp } from "./helpers";

test("without a desktop, the tools that need one aren't sent, and a search can't find them", async () => {
  const chat = new FakeModel([{ content: [text("Hi.")] }]);
  const t = await testApp(chat);
  t.agent.configured = false;
  await t.thread.post("hello").done;
  const names = (chat.requests[0]?.tools ?? []).flatMap((x) => ("name" in x ? [x.name] : []));
  expect(names).toContain("run_task");
  expect(names).not.toContain("send_file");
  expect(names).not.toContain("run_desktop_task");
});
