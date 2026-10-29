import { expect, test } from "bun:test";
import { HATBOT } from "../src/memory/store";
import { FakeModel, text, toolUse } from "./fake-model";
import { testApp, waitFor } from "./helpers";

const writes = [
  toolUse("memory_write", { path: "skills/x.md", content: "# X\nDo it", reason: "Add skill x" }),
  toolUse("memory_write", { path: "notes/x.md", content: "A note", reason: "Note x" }),
  toolUse("memory_delete", { path: "INDEX.md", reason: "Clear the index" }),
  toolUse("todo_add", { item: "Pay invoice 4471" }),
];

test("after reading untrusted content, with the review off, the chat's writes to skills, INDEX.md and the to-do list ask you", async () => {
  const model = new FakeModel([
    { content: writes.slice(0, 1) },
    { content: [text("Saved.")] },
    { content: writes },
    { content: [text("Saved.")] },
  ]);
  const t = await testApp(model);
  t.settings.update({ reviewChanges: false });
  // Untainted, a skill is written directly.
  await t.thread.post("add skill x").done;
  expect(await t.memory.read("skills/x.md")).toBe("# X\nDo it\n");
  await t.memory.delete("skills/x.md", HATBOT, "gone again");
  t.db.query("UPDATE episodes SET tainted = 1, tainted_by = 'https://example.com'").run();
  const reply = t.thread.post("save what that page said");

  const skill = await waitFor(() => t.approvals.list(true)[0]);
  expect(skill.summary).toContain("skills/x.md");
  expect(skill.sources).toEqual(["https://example.com"]);
  t.approvals.decide(skill.id, "deny", "web");
  const index = await waitFor(() => t.approvals.list(true)[0]);
  expect(index.summary).toContain("INDEX.md");
  t.approvals.decide(index.id, "deny", "web");
  const todo = await waitFor(() => t.approvals.list(true)[0]);
  t.approvals.decide(todo.id, "approve", "web");
  await reply.done;

  expect(await t.memory.read("notes/x.md")).toBe("A note\n");
  expect(await t.memory.exists("skills/x.md")).toBe(false);
  expect(await t.memory.exists("INDEX.md")).toBe(true);
  expect(await t.memory.read("todo.md")).toContain("Pay invoice 4471");
});
