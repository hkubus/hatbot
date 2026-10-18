import { expect, test } from "bun:test";
import { MATCH_END, MATCH_START, type SearchResults } from "@hatbot/shared";
import { HATBOT } from "../src/memory/store";
import { FakeModel, text } from "./fake-model";
import { bot, signIn, testApp } from "./helpers";

test("search finds chat messages, tasks, memory and schedules, and leaves out a deleted bot's chat and a deleted group", async () => {
  const t = await testApp(
    new FakeModel([
      { content: [text("The WireGuard tunnel uses port 51820.")] },
      { content: [text("WireGuard needs a key.")] },
      { content: [text("WireGuard, then.")] },
    ]),
  );
  const { cookie } = signIn(t);
  const search = async (q: string) =>
    (await (await t.call("GET", `/search?q=${q}`, undefined, { cookie })).json()) as SearchResults;
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

  // A prefix of the last word matches, so results come while you type.
  const r = await search("wiregu");
  expect(r.messages.map((m) => m.botId)).toEqual(expect.arrayContaining([null, "hatbot"]));
  expect(r.messages.find((m) => m.botId === "hatbot")?.snippet).toBe(
    `The ${MATCH_START}WireGuard${MATCH_END} tunnel uses port 51820.`,
  );
  expect(r.tasks.map((x) => x.title)).toEqual(["Rotate WireGuard keys"]);
  expect(r.memory).toEqual([
    { path: "notes/network.md", line: 2, text: "WireGuard on the router." },
  ]);
  expect(r.routines).toEqual([{ kind: "schedule", id: 1, name: "WireGuard check" }]);
  expect((await search("%25")).tasks).toEqual([]);
  expect((await t.call("GET", "/search?q=x")).status).toBe(401);

  // A bot's chat goes away with the bot; a group with it stays until it's deleted.
  bot(t, "Chef");
  await t.chats.direct("chef").post("wireguard keys?").done;
  const res = await t.call("POST", "/conversations", { botIds: ["chef", "hatbot"] }, { cookie });
  const group = (await res.json()) as { id: number };
  await t.chats.thread(group.id)?.post("wireguard or tailscale?").done;
  const found = async () =>
    new Set((await search("wireguard")).messages.map((m) => m.conversationId));
  expect(await found()).toEqual(new Set([1, 2, group.id]));
  await t.call("DELETE", "/bots/chef", undefined, { cookie });
  expect(await found()).toEqual(new Set([1, group.id]));
  await t.call("DELETE", `/conversations/${group.id}`, undefined, { cookie });
  expect(await found()).toEqual(new Set([1]));
});
