import { expect, test } from "bun:test";
import { MATCH_END, MATCH_START, type SearchResults } from "@hatbot/shared";
import { HATBOT } from "../src/memory/store";
import { FakeModel, text } from "./fake-model";
import { setUpOwner, testApp } from "./helpers";

test("search finds chat messages, tasks, memory and schedules", async () => {
  const t = await testApp(
    new FakeModel([{ content: [text("The WireGuard tunnel uses port 51820.")] }]),
  );
  const { cookie } = await setUpOwner(t);
  await t.thread.post("which port does wireguard use?").done;
  t.tasks.createBackgroundTask({
    title: "Rotate WireGuard keys",
    goal: "Rotate them",
    origin: "chat",
  });
  await t.memory.write(
    "notes/network.md",
    "# Network\nWireGuard on the router.\n",
    HATBOT,
    "Add notes",
  );
  t.schedules.create(
    { name: "WireGuard check", prompt: "Check the tunnel", cron: "0 8 * * *" },
    "owner",
  );
  t.schedules.create({ name: "Backups", prompt: "Check PBS", cron: "0 9 * * *" }, "owner");

  const res = await t.call("GET", "/search?q=wiregu", undefined, { cookie });
  const r = (await res.json()) as SearchResults;
  // A prefix of the last word matches, so results come while you type.
  expect(r.messages.map((m) => m.botId)).toEqual(expect.arrayContaining([null, "hatbot"]));
  expect(r.messages.find((m) => m.botId === "hatbot")?.snippet).toBe(
    `The ${MATCH_START}WireGuard${MATCH_END} tunnel uses port 51820.`,
  );
  expect(r.tasks.map((x) => x.title)).toEqual(["Rotate WireGuard keys"]);
  expect(r.memory).toEqual([
    { path: "notes/network.md", line: 2, text: "WireGuard on the router." },
  ]);
  expect(r.routines).toEqual([{ kind: "schedule", id: 1, name: "WireGuard check" }]);

  const none = (await (
    await t.call("GET", "/search?q=%25", undefined, { cookie })
  ).json()) as SearchResults;
  expect(none.tasks).toEqual([]);
  expect((await t.call("GET", "/search?q=x")).status).toBe(401);
});
