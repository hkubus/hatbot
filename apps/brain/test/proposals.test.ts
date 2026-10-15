import { expect, test } from "bun:test";
import type { Proposal, SkillStatus } from "@hatbot/shared";
import { HATBOT } from "../src/memory/store";
import { setUpOwner, testApp } from "./helpers";

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
  t.taskModel.onCreate = (p) => {
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
  };
  const res = await t.call("POST", "/proposals/tidy", undefined, { cookie });
  expect(res.status).toBe(201);
  const p = (await res.json()) as Proposal;
  expect(p.changes.map((c) => [c.path, c.before !== null, c.after !== null])).toEqual([
    ["network.md", true, false],
    ["home.md", true, true],
  ]);
  expect(t.taskModel.creates.at(-1)?.model).toBe("claude-opus-5-5");

  const applied = await t.call("POST", `/proposals/${p.id}/apply`, undefined, { cookie });
  expect(applied.status).toBe(200);
  expect(await t.memory.exists("network.md")).toBe(false);
  expect(await t.memory.read("home.md")).toContain("also the network notes");
  const [last] = await t.memory.log(1);
  expect(last).toMatchObject({ author: "You", message: "Tidy: Merge the router notes" });
  expect((await t.call("POST", `/proposals/${p.id}/apply`, undefined, { cookie })).status).toBe(
    409,
  );
});

test("a proposal goes stale when memory changes under it; nothing to tidy is no proposal", async () => {
  const t = await testApp();
  const { cookie } = await setUpOwner(t);
  await t.memory.write("a.md", "# A\nold\n", HATBOT, "A");
  t.taskModel.onCreate = () =>
    JSON.stringify({ title: "T", reason: "R", changes: [{ path: "a.md", content: "# A\nnew\n" }] });
  const p = (await (
    await t.call("POST", "/proposals/tidy", undefined, { cookie })
  ).json()) as Proposal;
  await t.memory.write("a.md", "# A\nedited by hand\n", HATBOT, "Edit");
  const res = await t.call("POST", `/proposals/${p.id}/apply`, undefined, { cookie });
  expect(res.status).toBe(409);
  expect(t.proposals.get(p.id)?.status).toBe("stale");

  t.taskModel.onCreate = () => JSON.stringify({ title: "Nothing", reason: "Tidy.", changes: [] });
  expect((await t.call("POST", "/proposals/tidy", undefined, { cookie })).status).toBe(204);
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

  t.taskModel.onCreate = (p) => {
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
  };
  const res = await t.call("POST", "/skills/order-pizza/fix", undefined, { cookie });
  expect(res.status).toBe(201);
  const p = (await res.json()) as Proposal;
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
