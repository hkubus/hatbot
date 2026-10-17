import { expect, test } from "bun:test";
import type { Proposal, SkillStatus } from "@hatbot/shared";
import type { StreamParams } from "../src/agent/model";
import { HATBOT } from "../src/memory/store";
import { text } from "./fake-model";
import { setUpOwner, type TestApp, testApp, waitFor } from "./helpers";

/** Answers each proposal request with the JSON `reply` gives, as the model would. */
function answers(t: TestApp, reply: (p: Omit<StreamParams, "stream">) => string) {
  t.taskModel.route = (p) => (p.output_config?.format ? { content: [text(reply(p))] } : undefined);
}

/** Starts a tidy-up and waits for the proposal it writes. */
async function tidy(t: TestApp, cookie: string): Promise<Proposal> {
  const before = t.proposals.list()[0]?.id ?? 0;
  const res = await t.call("POST", "/proposals/tidy", undefined, { cookie });
  expect(res.status).toBe(202);
  expect(await res.json()).toEqual({ started: true });
  return waitFor(() => {
    const p = t.proposals.list()[0];
    return p && p.id > before ? p : null;
  });
}

test("a tidy-up is proposed as a diff, and applied as you in one commit", async () => {
  const t = await testApp();
  const { cookie } = await setUpOwner(t);
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
    return JSON.stringify({
      title: "Merge the router notes",
      reason: "Both say where the router is.",
      changes: [
        { path: "network.md", delete: true },
        { path: "home.md", content: "# Home\nRouter: 192.168.1.1 (also the network notes)\n" },
        { path: "skills/x.md", content: "nope" },
      ],
    });
  });
  const p = await tidy(t, cookie);
  expect(t.events.some((e) => e.type === "proposal.updated" && e.proposal.id === p.id)).toBe(true);
  expect(p.changes.map((c) => [c.path, c.before !== null, c.after !== null])).toEqual([
    ["network.md", true, false],
    ["home.md", true, true],
  ]);
  // Opus 5.5 can't be made to call a tool: it answers in JSON of a set shape instead.
  const request = t.taskModel.requests.at(-1);
  expect(request).toMatchObject({
    model: "claude-opus-5-5",
    thinking: { type: "adaptive" },
    output_config: { format: { type: "json_schema" } },
  });
  expect(request?.tool_choice).toBeUndefined();
  expect(request?.tools).toBeUndefined();
  const found = async () => [...new Set((await t.memory.search("router")).map((h) => h.path))];
  expect(await found()).toEqual(expect.arrayContaining(["home.md", "network.md"]));

  const applied = await t.call("POST", `/proposals/${p.id}/apply`, undefined, { cookie });
  expect(applied.status).toBe(200);
  expect(await t.memory.exists("network.md")).toBe(false);
  expect(await t.memory.read("home.md")).toContain("also the network notes");
  // Search follows it.
  expect(await found()).toEqual(["home.md"]);
  const [last] = await t.memory.log(1);
  expect(last).toMatchObject({ author: "You", message: "Tidy: Merge the router notes" });
  expect((await t.call("POST", `/proposals/${p.id}/apply`, undefined, { cookie })).status).toBe(
    409,
  );
});

test("a tidy-up whose stream failed partway is billed for that try too", async () => {
  const t = await testApp();
  const { cookie } = await setUpOwner(t);
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

test("a proposal goes stale when memory changes under it; nothing to tidy is no proposal", async () => {
  const t = await testApp();
  const { cookie } = await setUpOwner(t);
  await t.memory.write("a.md", "# A\nold\n", HATBOT, "A");
  answers(t, () =>
    JSON.stringify({ title: "T", reason: "R", changes: [{ path: "a.md", content: "# A\nnew\n" }] }),
  );
  const p = await tidy(t, cookie);
  await t.memory.write("a.md", "# A\nedited by hand\n", HATBOT, "Edit");
  const res = await t.call("POST", `/proposals/${p.id}/apply`, undefined, { cookie });
  expect(res.status).toBe(409);
  expect(t.proposals.get(p.id)?.status).toBe("stale");

  // Nothing to tidy, or a failure: you're told.
  answers(t, () => JSON.stringify({ title: "Nothing", reason: "Tidy.", changes: [] }));
  expect((await t.call("POST", "/proposals/tidy", undefined, { cookie })).status).toBe(202);
  await waitFor(() => t.notifier.sent.find((n) => n.title === "Memory is tidy"));
  answers(t, () => {
    throw new Error("overloaded");
  });
  expect((await t.call("POST", "/proposals/tidy", undefined, { cookie })).status).toBe(202);
  const told = await waitFor(() =>
    t.notifier.sent.find((n) => n.title === "The tidy-up of memory failed"),
  );
  expect(told.message).toContain("overloaded");
  // An answer that isn't the JSON asked for.
  answers(t, () => "I'd merge the router notes.");
  expect((await t.call("POST", "/proposals/tidy", undefined, { cookie })).status).toBe(202);
  const unread = await waitFor(() =>
    t.notifier.sent.find((n) => n.message === "The model's answer couldn't be read. Try again."),
  );
  expect(unread.title).toBe("The tidy-up of memory failed");
});

test("a skill whose tasks failed or needed you is flagged, and its fix replaces it", async () => {
  const t = await testApp();
  const { cookie } = await setUpOwner(t);
  await t.skills.save(
    "order-pizza",
    "---\nname: order-pizza\ndescription: Order pizza\n---\n# Order pizza\n1. Open pizza.example\n",
    HATBOT,
  );
  const insert = (status: string) =>
    t.db
      .query<{ id: number }, [string, string]>(
        `INSERT INTO tasks (title, goal, success_criteria, origin, lane, model, status, budget_usd, created_at, skill)
         VALUES ('Pizza', 'Order a pizza', '', 'chat', 'screen', 'm', ?, 1, ?, 'order-pizza') RETURNING id`,
      )
      // Commits are dated by the real clock.
      .get(status, new Date().toISOString())?.id as number;
  await Bun.sleep(1100);
  const failed = insert("failed");
  insert("done");
  const handed = insert("done");
  t.tasks.addStep(handed, {
    kind: "takeover",
    name: "Hatbot asked you to take over",
    detail: "A captcha",
    url: null,
  });
  t.tasks.addStep(failed, {
    kind: "error",
    name: "The Order button is gone",
    detail: "",
    url: null,
  });

  const [s] = (await (
    await t.call("GET", "/skills", undefined, { cookie })
  ).json()) as SkillStatus[];
  expect(s).toMatchObject({ name: "order-pizza", runs: 3, failed: [failed], takeovers: [handed] });

  answers(t, (p) => {
    expect(JSON.stringify(p.messages)).toContain("The Order button is gone");
    return JSON.stringify({
      title: "Use the new checkout",
      reason: "The Order button moved.",
      changes: [
        {
          path: "skills/order-pizza.md",
          content:
            "---\nname: order-pizza\ndescription: Order pizza\n---\n# Order pizza\n1. Open pizza.example/checkout\n",
        },
      ],
    });
  });
  const res = await t.call("POST", "/skills/order-pizza/fix", undefined, { cookie });
  expect(res.status).toBe(202);
  const p = await waitFor(() => t.proposals.list()[0]);
  expect(p).toMatchObject({ kind: "skill", skill: "order-pizza" });
  await Bun.sleep(1100);
  await t.call("POST", `/proposals/${p.id}/apply`, undefined, { cookie });
  expect(await t.memory.read("skills/order-pizza.md")).toContain("/checkout");
  // Changed since: no runs yet.
  const [after] = (await (
    await t.call("GET", "/skills", undefined, { cookie })
  ).json()) as SkillStatus[];
  expect(after).toMatchObject({ runs: 0, failed: [], takeovers: [] });
});
