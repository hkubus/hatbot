import { expect, test } from "bun:test";
import type { Proposal } from "@hatbot/shared";
import { HATBOT } from "../src/memory/store";
import { FakeModel, text, toolUse } from "./fake-model";
import { signIn, type TestApp, testApp } from "./helpers";

const writes = [
  toolUse("memory_write", { path: "skills/x.md", content: "# X\nDo it", reason: "Add skill x" }),
  toolUse("memory_write", { path: "notes/x.md", content: "A note", reason: "Note x" }),
  toolUse("memory_delete", { path: "INDEX.md", reason: "Clear the index" }),
  toolUse("todo_add", { item: "Pay invoice 4471" }),
];
const pending = (t: TestApp) =>
  t.db
    .query<{ kind: string; title: string; changes: string }, []>(
      "SELECT kind, title, changes FROM proposals WHERE status = 'pending' ORDER BY id",
    )
    .all()
    .map((p) => ({ ...p, path: (JSON.parse(p.changes) as Proposal["changes"])[0]?.path }));

test("after reading untrusted content, the chat's writes to skills, INDEX.md and the to-do list wait for you", async () => {
  const model = new FakeModel([
    { content: writes.slice(0, 1) },
    { content: [text("Saved.")] },
    { content: writes },
    { content: [text("Saved.")] },
  ]);
  const t = await testApp(model);
  // Untainted, a skill is written directly.
  await t.thread.post("add skill x").done;
  expect(await t.memory.read("skills/x.md")).toBe("# X\nDo it\n");
  await t.memory.delete("skills/x.md", HATBOT, "gone again");
  t.db.query("UPDATE episodes SET tainted = 1, tainted_by = 'https://example.com'").run();
  await t.thread.post("save what that page said").done;

  expect(await t.memory.read("notes/x.md")).toBe("A note\n");
  expect(await t.memory.exists("skills/x.md")).toBe(false);
  expect(await t.memory.exists("INDEX.md")).toBe(true);
  expect(await t.memory.exists("todo.md")).toBe(false);
  expect(pending(t)).toMatchObject([
    { kind: "write", path: "skills/x.md" },
    { kind: "write", path: "INDEX.md" },
    { kind: "write", path: "todo.md" },
  ]);
  expect(t.proposals.list("pending")[0]?.reason).toContain("https://example.com");
});

test("a held write applies as you, dismisses, and goes stale when the file changes", async () => {
  const model = new FakeModel([{ content: [text("hi")] }]);
  const t = await testApp(model);
  const { cookie } = signIn(t);
  await t.thread.post("hello").done;
  t.db.query("UPDATE episodes SET tainted = 1, tainted_by = 'https://example.com'").run();
  const hold = async () => {
    model.script.push({ content: writes.slice(0, 1) }, { content: [] });
    await t.thread.post("save it").done;
    return t.proposals.list("pending")[0] as Proposal;
  };
  const first = await hold();
  const applied = await t.call("POST", `/proposals/${first.id}/apply`, undefined, { cookie });
  expect(applied.status).toBe(200);
  expect(await t.memory.read("skills/x.md")).toBe("# X\nDo it\n");
  expect((await t.memory.log(1))[0]).toMatchObject({ author: "You", message: "Add skill x" });

  await t.memory.delete("skills/x.md", HATBOT, "gone again");
  const second = await hold();
  const dismissed = await t.call("POST", `/proposals/${second.id}/dismiss`, undefined, { cookie });
  expect(dismissed.status).toBe(200);
  expect(await t.memory.exists("skills/x.md")).toBe(false);

  const third = await hold();
  await t.memory.write("skills/x.md", "# X\nBy hand", HATBOT, "by hand");
  const stale = await t.call("POST", `/proposals/${third.id}/apply`, undefined, { cookie });
  expect(stale.status).toBe(409);
  expect(t.proposals.get(third.id)?.status).toBe("stale");
  expect(await t.memory.read("skills/x.md")).toBe("# X\nBy hand\n");
});
