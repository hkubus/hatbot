import { expect, test } from "bun:test";
import { HATBOT } from "../src/memory/store";
import { FakeModel, text, toolUse } from "./fake-model";
import { testApp } from "./helpers";

const summary = "<recap>Talked.</recap>\n<summary>2026-10-09: talked.</summary>";
const write = (path: string, content: string, reason: string) =>
  toolUse("memory_write", { path, content, reason });

test("a folded conversation is looked back on once, from its own cache, with only memory's tools; one out of the cache isn't", async () => {
  const model = new FakeModel(
    [
      { content: [text("Noted.")] },
      {
        content: [
          write("people/anna.md", "# Anna\n\nThe owner's sister. Lives in Lisbon.\n", "Anna"),
          toolUse("run_task", { title: "Visit", goal: "Book a flight to Lisbon" }),
        ],
      },
      { content: [text("Nothing else to keep.")] },
      { content: [text("Sure.")] },
    ],
    [summary, summary],
  );
  model.caching = true;
  const t = await testApp(model);
  await t.thread.post("my sister Anna moved to Lisbon").done;
  t.advance(31 * 60_000);
  await Promise.all([t.thread.sweep(), t.thread.sweep()]);
  await t.thread.sweep();

  expect(model.requests).toHaveLength(3);
  const [reply, back, after] = model.requests;
  // The reply's system prompt, tools and turns, then its answer and the ask to look back.
  expect(JSON.stringify(back?.system)).toBe(JSON.stringify(reply?.system));
  expect(JSON.stringify(back?.tools)).toBe(JSON.stringify(reply?.tools));
  expect(back?.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  const read = t.db
    .query<{ r: number }, []>(
      "SELECT cache_read_tokens AS r FROM spend_ledger WHERE purpose = 'reflect' ORDER BY id LIMIT 1",
    )
    .get();
  expect(read?.r).toBeGreaterThan(0);

  expect(await t.memory.read("people/anna.md")).toContain("Lisbon");
  expect((await t.memory.log(1))[0]?.message).toBe("Looking back: Anna");
  const results = after?.messages.at(-1)?.content as { is_error: boolean }[];
  expect(results.map((r) => r.is_error)).toEqual([false, true]);
  expect(t.tasks.list()).toHaveLength(0);
  expect(t.notifier.sent.at(-1)?.message).toBe("people/anna.md");

  await t.thread.post("thanks").done;
  t.advance(61 * 60_000);
  await t.thread.sweep();
  expect(model.requests).toHaveLength(4);
});

test("looking back, a delete, a cut of more than a quarter, and anything after untrusted content wait for you", async () => {
  const model = new FakeModel(
    [
      { content: [text("Noted.")] },
      {
        content: [
          write("homelab.md", "# Homelab\n", "Shorter"),
          toolUse("memory_delete", { path: "old.md", reason: "Stale" }),
          write("people/anna.md", "# Anna\n\nLives in Lisbon.\n", "Anna"),
        ],
      },
      { content: [text("Done.")] },
      { content: [text("Read it.")] },
      { content: [write("people/bob.md", "# Bob\n\nWorks at the bank.\n", "Bob")] },
      { content: [text("Done.")] },
    ],
    [summary, summary],
  );
  model.caching = true;
  const t = await testApp(model);
  await t.memory.write("homelab.md", `# Homelab\n\n${"- a host\n".repeat(20)}`, HATBOT, "Hosts");
  await t.memory.write("old.md", "# Old\n", HATBOT, "Old");

  await t.thread.post("Anna moved to Lisbon").done;
  t.advance(31 * 60_000);
  await t.thread.sweep();
  expect(await t.memory.read("people/anna.md")).toContain("Lisbon");
  expect(await t.memory.read("homelab.md")).toContain("- a host");
  expect(await t.memory.exists("old.md")).toBe(true);

  await t.thread.post("what does this page say about Bob?").done;
  t.db
    .query(
      "UPDATE episodes SET tainted = 1, tainted_by = 'https://example.com' WHERE id = (SELECT max(id) FROM episodes)",
    )
    .run();
  t.advance(31 * 60_000);
  await t.thread.sweep();
  expect(await t.memory.exists("people/bob.md")).toBe(false);

  expect(
    t.proposals
      .list("pending")
      .map((p) => p.changes[0]?.path)
      .sort(),
  ).toEqual(["homelab.md", "old.md", "people/bob.md"]);
});
