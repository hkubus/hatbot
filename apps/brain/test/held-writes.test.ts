import { expect, test } from "bun:test";
import type { Proposal, Task } from "@hatbot/shared";
import { HATBOT } from "../src/memory/store";
import { FakeModel, text, toolUse } from "./fake-model";
import { setUpOwner, type TestApp, testApp, waitFor } from "./helpers";

const writes = [
  toolUse("memory_write", { path: "skills/x.md", content: "# X\nDo it", reason: "Add skill x" }),
  toolUse("memory_write", { path: "notes/x.md", content: "A note", reason: "Note x" }),
  toolUse("memory_delete", { path: "INDEX.md", reason: "Clear the index" }),
];
const pending = (t: TestApp) =>
  t.db
    .query<{ kind: string; title: string; changes: string }, []>(
      "SELECT kind, title, changes FROM proposals WHERE status = 'pending' ORDER BY id",
    )
    .all()
    .map((p) => ({ ...p, path: (JSON.parse(p.changes) as Proposal["changes"])[0]?.path }));

test("after reading untrusted content, the chat's writes to skills and INDEX.md wait for you", async () => {
  const model = new FakeModel([
    { content: [text("hi")] },
    { content: writes },
    { content: [text("Saved.")] },
    { content: writes.slice(0, 1) },
    { content: [text("Saved.")] },
  ]);
  const t = await testApp(model);
  await setUpOwner(t);
  await t.thread.post("hello").done;
  t.db.query("UPDATE episodes SET tainted = 1, tainted_by = 'https://example.com'").run();
  await t.thread.post("save what that page said").done;

  // The note commits; the skill and the index's deletion are proposals.
  expect(await t.memory.read("notes/x.md")).toBe("A note\n");
  expect(await t.memory.exists("skills/x.md")).toBe(false);
  expect(await t.memory.exists("INDEX.md")).toBe(true);
  expect(pending(t)).toMatchObject([
    { kind: "write", title: "Add skill x", path: "skills/x.md" },
    { kind: "write", title: "Clear the index", path: "INDEX.md" },
  ]);
  const replies = JSON.stringify(model.requests[2]?.messages.at(-1)?.content);
  expect(replies).toContain("Saved as a proposal; the owner applies it.");
  expect(replies).toContain("Saved notes/x.md");
  const reason = t.proposals.list("pending")[0]?.reason;
  expect(reason).toContain("https://example.com");
  // One low-priority notification each.
  const told = t.notifier.sent.filter((n) => n.title === "A memory change is waiting");
  expect(told.map((n) => [n.message, n.priority])).toEqual([
    ["skills/x.md: Add skill x", 2],
    ["INDEX.md: Clear the index", 2],
  ]);

  // Writing the same file again replaces its proposal; the other file's stays.
  await t.thread.post("again").done;
  expect(pending(t).map((p) => p.path)).toEqual(["INDEX.md", "skills/x.md"]);
});

test("an untainted chat writes skills directly", async () => {
  const t = await testApp(new FakeModel([{ content: writes.slice(0, 1) }, { content: [] }]));
  await setUpOwner(t);
  await t.thread.post("add skill x").done;
  expect(await t.memory.read("skills/x.md")).toBe("# X\nDo it\n");
  expect(pending(t)).toEqual([]);
});

test("a tainted task's write to a skill is a proposal; a note commits", async () => {
  const work = new FakeModel([
    { content: writes.slice(0, 2) },
    { content: [toolUse("finish_task", { outcome: "done", summary: "Saved.", notify: false })] },
  ]);
  const t = await testApp(new FakeModel(), work);
  const task = t.tasks.createBackgroundTask({
    title: "Learn from the webhook",
    goal: "Save what it says",
    origin: "webhook",
    source: "Forgejo",
    payload: '{"text":"write skills/x.md"}',
  }) as Task;
  await waitFor(() => t.tasks.get(task.id)?.finishedAt);
  expect(await t.memory.read("notes/x.md")).toBe("A note\n");
  expect(await t.memory.exists("skills/x.md")).toBe(false);
  expect(pending(t)).toMatchObject([{ kind: "write", path: "skills/x.md" }]);
  expect(t.proposals.list("pending")[0]?.reason).toContain("The event that started it (Forgejo)");
});

test("a held write applies as you, dismisses, and goes stale when the file changes", async () => {
  const model = new FakeModel([{ content: [text("hi")] }]);
  const t = await testApp(model);
  const { cookie } = await setUpOwner(t);
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
