import { expect, test } from "bun:test";
import type { Proposal } from "@hatbot/shared";
import type { StreamParams } from "../src/agent/model";
import { HATBOT } from "../src/memory/store";
import { text } from "./fake-model";
import { signIn, type TestApp, testApp, waitFor } from "./helpers";

function answers(t: TestApp, reply: (p: Omit<StreamParams, "stream">) => string) {
  t.taskModel.route = (p) => (p.output_config?.format ? { content: [text(reply(p))] } : undefined);
}

async function tidy(t: TestApp, cookie: string): Promise<Proposal> {
  const before = t.proposals.list()[0]?.id ?? 0;
  expect((await t.call("POST", "/proposals/tidy", undefined, { cookie })).status).toBe(202);
  return waitFor(() => {
    const p = t.proposals.list()[0];
    return p && p.id > before ? p : null;
  });
}

test("a tidy-up holds what it may cost while asked, can't reach skills, and is applied as you", async () => {
  const t = await testApp();
  const { cookie } = signIn(t);
  t.settings.update({ limits: { taskUsd: 3, dailyUsd: 1, monthlyUsd: 200, alertReserveUsd: 0 } });
  await t.memory.writeAll(
    [
      { path: "home.md", content: "# Home\nRouter: 192.168.1.1\n" },
      { path: "network.md", content: "# Network\nThe router is at 192.168.1.1.\n" },
    ],
    HATBOT,
    "Notes",
  );
  answers(t, (p) => {
    expect(JSON.stringify(p.messages)).toContain("The router is at 192.168.1.1.");
    // What it may cost is held while it's asked, so nothing else can spend it meanwhile.
    expect(() => t.spend.check(0.5)).toThrow("Today's $1 limit");
    return JSON.stringify({
      title: "Merge the router notes",
      reason: "Both say where the router is.",
      changes: [
        { path: "network.md", delete: true },
        { path: "home.md", content: "# Home\nRouter: 192.168.1.1 (also the network notes)\n" },
        // Skills are the owner's to change, however the path is written.
        { path: "skills/x.md", content: "nope" },
        { path: "notes/../skills/y.md", content: "nope" },
        { path: "./skills/z.md", content: "nope" },
      ],
    });
  });
  const p = await tidy(t, cookie);
  expect(p.changes.map((c) => [c.path, c.before !== null, c.after !== null])).toEqual([
    ["network.md", true, false],
    ["home.md", true, true],
  ]);
  const found = async () => [...new Set((await t.memory.search("router")).map((h) => h.path))];
  expect(await found()).toEqual(expect.arrayContaining(["home.md", "network.md"]));

  const applied = await t.call("POST", `/proposals/${p.id}/apply`, undefined, { cookie });
  expect(applied.status).toBe(200);
  expect(await t.memory.exists("network.md")).toBe(false);
  expect(await found()).toEqual(["home.md"]);
  const [last] = await t.memory.log(1);
  expect(last?.author).toBe("You");
  expect((await t.call("POST", `/proposals/${p.id}/apply`, undefined, { cookie })).status).toBe(
    409,
  );
});

test("a tidy-up whose stream failed partway is billed for that try too", async () => {
  const t = await testApp();
  const { cookie } = signIn(t);
  await t.memory.writeAll([{ path: "home.md", content: "# Home\nRouter\n" }], HATBOT, "Notes");
  t.taskModel.route = (p) =>
    p.output_config?.format
      ? {
          content: [
            text(
              JSON.stringify({
                title: "Tidy home",
                reason: "Shorter.",
                changes: [{ path: "home.md", content: "# Home\nThe router.\n" }],
              }),
            ),
          ],
          failedWith: "",
          failedUsage: { input_tokens: 5000, output_tokens: 0 },
        }
      : undefined;
  await tidy(t, cookie);
  const rows = t.db
    .query<{ input_tokens: number }, []>(
      "SELECT input_tokens FROM spend_ledger WHERE purpose = 'tidy' ORDER BY id",
    )
    .all();
  expect(rows.map((r) => r.input_tokens)).toEqual([5000, 1000]);
});
