import { expect, test } from "bun:test";
import { matchingCommands, parseCommand, type ThreadMessage, threadGroups } from "@hatbot/shared";
import type { StreamHandlers, StreamParams } from "../src/agent/model";
import { activity, parseSummary, titleOf, withNote } from "../src/agent/thread";
import { costOf } from "../src/spend";
import { FakeModel, text, toolUse } from "./fake-model";
import { setUpOwner, testApp } from "./helpers";

const lastUserText = (req: { messages: { role: string; content: unknown }[] }) =>
  JSON.stringify(req.messages.at(-1)?.content);

test("a message gets a streamed reply, stored and searchable", async () => {
  const t = await testApp(new FakeModel([{ content: [text("Hi! I'm Hatbot.")] }]));
  const { cookie } = await setUpOwner(t);
  const res = await t.call("POST", "/thread/messages", { text: "hello there" }, { cookie });
  expect(res.status).toBe(202);
  await t.thread.idle();

  const msgs = (await (await t.call("GET", "/thread/messages", undefined, { cookie })).json()) as {
    role: string;
    text: string;
    status: string;
  }[];
  expect(msgs.map((m) => [m.role, m.text, m.status])).toEqual([
    ["user", "hello there", "done"],
    ["assistant", "Hi! I'm Hatbot.", "done"],
  ]);
  expect(t.events.map((e) => e.type)).toContain("message.delta");
  expect(t.events.at(-1)).toMatchObject({ type: "message.done", status: "done" });

  const req = t.model.requests[0];
  // Haiku 5.5 by default: no server-side fallback, and no progress-note display.
  expect(req?.model).toBe("claude-haiku-5-5");
  expect(req?.fallbacks).toBeUndefined();
  expect(req?.thinking).toEqual({
    type: "adaptive",
    block_binding: { prefix_mismatch_behavior: "drop_block" },
  });
  expect(req?.tools?.some((x) => "name" in x && x.name === "ask_opus")).toBe(true);
  expect(req?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  // New episode: context block first, then the timestamped message.
  expect(lastUserText(req as never)).toContain("<memory_index>");
  expect(lastUserText(req as never)).toContain("hello there");
});

test("tool calls run and their results go back to the model", async () => {
  const model = new FakeModel([
    {
      content: [
        toolUse("memory_write", {
          path: "about-you.md",
          content: "# About you\nLikes tea",
          reason: "Note tea",
        }),
      ],
    },
    { content: [text("Noted.")] },
  ]);
  const t = await testApp(model);
  await setUpOwner(t);
  await t.thread.post("I like tea").done;

  expect(await t.memory.read("about-you.md")).toBe("# About you\nLikes tea\n");
  const second = model.requests[1];
  expect(second?.messages.at(-1)?.content).toMatchObject([
    { type: "tool_result", is_error: false },
  ]);
  // The assistant turn with the tool call is replayed exactly.
  expect(second?.messages.at(-2)).toMatchObject({
    role: "assistant",
    content: [{ type: "tool_use", name: "memory_write" }],
  });
  expect(t.events.some((e) => e.type === "memory.committed")).toBe(true);
});

test("bad tool input comes back as an error result, not a crash", async () => {
  const model = new FakeModel([
    { content: [toolUse("memory_write", { path: "x.md" })] },
    { content: [text("Sorry, retrying later.")] },
  ]);
  const t = await testApp(model);
  await t.thread.post("save something").done;
  expect(model.requests[1]?.messages.at(-1)?.content).toMatchObject([
    { type: "tool_result", is_error: true },
  ]);
});

test("within 30 minutes the episode continues; after, a new one starts with a summary", async () => {
  const model = new FakeModel(
    [{ content: [text("one")] }, { content: [text("two")] }, { content: [text("three")] }],
    ["They said one and two."],
  );
  const t = await testApp(model);
  await t.thread.post("first").done;
  t.advance(10 * 60_000);
  await t.thread.post("second").done;
  // Same episode: the history is replayed and only the new message is appended.
  expect(model.requests[1]?.messages.length).toBe(3);
  expect(lastUserText(model.requests[1] as never)).not.toContain("<context>");

  t.advance(31 * 60_000);
  await t.thread.post("third").done;
  expect(model.creates.length).toBe(1);
  expect(model.requests[2]?.messages.length).toBe(1);
  const opening = lastUserText(model.requests[2] as never);
  expect(opening).toContain("They said one and two.");
  expect(opening).toContain("Owner: second");
});

test("an update that changes the prompt or tools starts a new episode", async () => {
  const model = new FakeModel([{ content: [text("one")] }, { content: [text("two")] }], ["s"]);
  const t = await testApp(model);
  await t.thread.post("first").done;
  // As if the episode had started on an older release.
  t.db.query("UPDATE episodes SET prefix = 'older'").run();
  t.advance(60_000);
  await t.thread.post("second").done;
  expect(model.requests[1]?.messages.length).toBe(1);
  expect(lastUserText(model.requests[1] as never)).toContain("Owner: first");
  // Thinking that fails the check anyway is dropped instead of failing the reply.
  expect(model.requests[1]?.thinking).toMatchObject({
    block_binding: { prefix_mismatch_behavior: "drop_block" },
  });
  expect(model.requests[1]?.betas).toContain("thinking-binding-controls-2026-08-01");
});

test("system prompt and tools are identical across requests (cache-stable)", async () => {
  const model = new FakeModel([{ content: [text("a")] }, { content: [text("b")] }]);
  const t = await testApp(model);
  await t.thread.post("x").done;
  t.advance(60 * 60_000);
  await t.thread.post("y").done;
  expect(JSON.stringify(model.requests[0]?.system)).toBe(JSON.stringify(model.requests[1]?.system));
  expect(JSON.stringify(model.requests[0]?.tools)).toBe(JSON.stringify(model.requests[1]?.tools));
});

test("spend is recorded, and the daily limit stops replies", async () => {
  const t = await testApp(new FakeModel([{ content: [text("ok")] }]));
  t.settings.update({ chatModel: "claude-opus-5-5" });
  await t.thread.post("hi").done;
  // Opus 5.5: 1000 input * $4/M + 200 output * $20/M
  expect(t.spend.summary().todayUsd).toBeCloseTo(0.008, 6);

  t.settings.update({ limits: { taskUsd: 3, dailyUsd: 0.005, monthlyUsd: 200 } });
  await t.thread.post("again").done;
  const last = t.thread.list().at(-1);
  expect(last).toMatchObject({ role: "assistant", status: "error" });
  expect(last?.text).toContain("limit");
});

test("pause all stops new replies", async () => {
  const t = await testApp(new FakeModel([]));
  const { cookie } = await setUpOwner(t);
  await t.call("POST", "/pause-all", {}, { cookie });
  await t.thread.post("hi").done;
  expect(t.thread.list().at(-1)?.text).toContain("Paused");
  expect(t.model.requests.length).toBe(0);
});

test("fallback iterations are billed per model", async () => {
  const t = await testApp();
  t.spend.recordResponse({
    model: "claude-sonnet-5-5",
    purpose: "thread",
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      iterations: [
        { model: "claude-sonnet-5-5", input_tokens: 1_000_000, output_tokens: 0 },
        { model: "claude-haiku-4-5", input_tokens: 1_000_000, output_tokens: 0 },
      ],
    },
  });
  expect(t.spend.summary().todayUsd).toBeCloseTo(3, 6);
});

test("search_history finds older conversations, not the one you're in", async () => {
  const model = new FakeModel([
    { content: [text("Got it.")] },
    { content: [toolUse("search_history", { query: "wireguard port" })] },
    { content: [text("Found it.")] },
  ]);
  const t = await testApp(model);
  await t.thread.post("my wireguard port is 51820").done;
  t.advance(31 * 60_000);
  await t.thread.post("what was my wireguard port?").done;
  const result = JSON.stringify(model.requests[2]?.messages.at(-1)?.content);
  expect(result).toContain("51820");
  expect(result).not.toContain("what was my");
});

test("Haiku 5.5 bills the whole request at the long-prompt price past 100k prompt tokens", () => {
  const short = costOf("claude-haiku-5-5", {
    input: 100_000,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    cacheRead: 0,
    output: 1_000,
  });
  const long = costOf("claude-haiku-5-5", {
    input: 90_000,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    cacheRead: 10_001,
    output: 1_000,
  });
  expect(short).toBeCloseTo((100_000 * 0.1 + 1_000 * 0.5) / 1e6, 9);
  expect(long).toBeCloseTo((90_000 * 0.5 + 10_001 * 0.05 + 1_000 * 2.5) / 1e6, 9);
});

test("a conversation idle for 30 minutes gets a recap; the running summary carries on", async () => {
  const model = new FakeModel(
    [{ content: [text("Disk sdb is failing.")] }, { content: [text("Sure.")] }],
    [
      "<recap>Asked about the NAS disks; sdb is failing.</recap>\n<summary>2026-10-09: sdb on the NAS is failing.</summary>",
    ],
  );
  const t = await testApp(model);
  await t.thread.post("how are the NAS disks?").done;
  const [user, reply] = t.thread.list();
  expect(user?.episodeId).toBe(reply?.episodeId as number);
  expect(t.events.some((e) => e.type === "message.created" && e.message.episodeId)).toBe(true);

  await t.thread.sweep();
  expect(model.creates.length).toBe(0);
  t.advance(31 * 60_000);
  await Promise.all([t.thread.sweep(), t.thread.sweep()]);
  expect(model.creates.length).toBe(1);
  const [episode] = t.thread.episodes([reply?.episodeId as number]);
  expect(episode?.recap).toBe("Asked about the NAS disks; sdb is failing.");
  expect(t.events.some((e) => e.type === "episode.updated" && e.episode.recap)).toBe(true);

  // The next message starts a new conversation without summarizing the last one again.
  await t.thread.post("thanks").done;
  expect(model.creates.length).toBe(1);
  expect(lastUserText(model.requests[1] as never)).toContain(
    "2026-10-09: sdb on the NAS is failing.",
  );
  const { cookie } = await setUpOwner(t);
  const res = await t.call("GET", `/thread/episodes?ids=${reply?.episodeId}`, undefined, {
    cookie,
  });
  expect(((await res.json()) as { recap: string }[])[0]?.recap).toContain("NAS disks");
  expect((await t.call("GET", "/thread/episodes?ids=1;drop", undefined, { cookie })).status).toBe(
    400,
  );
});

test("an answer without the tags is all running summary", () => {
  expect(parseSummary("Just a summary.")).toEqual({ recap: null, summary: "Just a summary." });
  expect(parseSummary("<recap> R </recap><summary> S </summary>")).toEqual({
    recap: "R",
    summary: "S",
  });
});

test("the chat folds every finished conversation; cards join the one before", () => {
  const m = (id: number, episodeId: number | null, role: "user" | "assistant" = "assistant") =>
    ({ id, role, kind: "text", text: `message ${id}`, episodeId }) as ThreadMessage;
  const groups = threadGroups(
    [m(1, null), m(2, 1, "user"), m(3, 1), m(4, null), m(5, 2, "user"), m(6, 3, "user"), m(7, 3)],
    { 1: { id: 1, startedAt: "", lastActivityAt: "", recap: "Talked about one." } },
  );
  expect(groups.map((g) => [g.episodeId, g.messages.map((x) => x.id), g.fold])).toEqual([
    [null, [1], null],
    [1, [2, 3, 4], "Talked about one."],
    [2, [5], "message 5"],
    [3, [6, 7], null],
  ]);
});

test("while it works the reply says what it's doing and what it has used", async () => {
  const model = new FakeModel([
    { content: [toolUse("memory_read", { path: "homelab.md" })] },
    { content: [text("Your NAS is fine.")] },
  ]);
  const t = await testApp(model);
  await t.memory.write("homelab.md", "# Homelab\n", t.settings.get().owner, "x");
  await t.thread.post("how is the nas?").done;
  const lines = t.events
    .filter((e) => e.type === "message.progress")
    .map((e) => (e as { text: string }).text.trim());
  expect(lines).toEqual(["Thinking…", "Reading memory: homelab.md", "Thinking…"]);
  const usage = t.events.filter((e) => e.type === "message.usage") as {
    tokens: number;
    costUsd: number;
  }[];
  // Two model calls of 1,200 tokens each in the fake.
  expect(usage.map((u) => u.tokens)).toEqual([1200, 2400]);
  expect(usage.at(-1)?.costUsd).toBeCloseTo(t.spend.summary().todayUsd, 9);
});

test("working lines name the inputs that matter, briefly", () => {
  expect(activity("Checking a host", { host: "nas", what: "logs", unit: "nginx" })).toBe(
    "Checking a host: nas, logs, nginx",
  );
  expect(activity("Looking at schedules", {})).toBe("Looking at schedules");
  expect(activity("Searching memory", { query: "x".repeat(100) })).toHaveLength(98);
});

test("spend over the last hour and minute, in dollars and tokens; hour by hour", async () => {
  const t = await testApp();
  const usage = { input_tokens: 1000, output_tokens: 200 };
  t.spend.record({ model: "claude-haiku-5-5", purpose: "summary", usage });
  t.advance(30 * 60_000);
  t.spend.record({ model: "claude-haiku-5-5", purpose: "summary", usage });
  const s = t.spend.summary();
  expect(s.todayTokens).toBe(2400);
  expect(s.lastHour.tokens).toBe(2400);
  expect(s.lastMinute.tokens).toBe(1200);
  expect(s.lastMinute.usd).toBeCloseTo((1000 * 0.1 + 200 * 0.5) / 1e6, 12);
  const hours = t.spend.hourly(24);
  expect(hours).toHaveLength(24);
  expect(hours.reduce((n, h) => n + h.tokens, 0)).toBe(2400);
  const { cookie } = await setUpOwner(t);
  const res = await t.call("GET", "/spend/hourly?hours=6", undefined, { cookie });
  expect(((await res.json()) as unknown[]).length).toBe(6);
});

test("text after a tool call is set apart with a rule", async () => {
  const model = new FakeModel([
    { content: [text("Let me check."), toolUse("memory_list", {})] },
    { content: [text("Nothing in memory yet.")] },
  ]);
  const t = await testApp(model);
  await t.thread.post("what do you remember?").done;
  const reply = t.thread.list().at(-1);
  expect(reply?.text).toBe("Let me check.\n\n---\n\nNothing in memory yet.");
});

test("on Haiku the chat can ask Opus once per reply; the answer goes in as is", async () => {
  const code = "```python\nprint(sum(range(10)))\n```";
  const model = new FakeModel([
    {
      content: [
        text("I'll get Opus to write that."),
        toolUse("ask_opus", { question: "Sum 0..9 in Python", context: "Owner uses Python 3.12" }),
      ],
    },
    // A second ask in the same reply is refused.
    { content: [toolUse("ask_opus", { question: "Again", context: "" })] },
    { content: [text("Run it with python3.")] },
  ]);
  // The expert's streamed answer comes from the same fake, scripted after the chat's turns.
  model.script.splice(1, 0, { content: [text(code)] });
  const t = await testApp(model);
  await t.thread.post("write me a python one-liner to sum 0..9").done;

  const expert = model.requests[1];
  expect(expert?.model).toBe("claude-opus-5-5");
  expect(expert?.output_config).toEqual({ effort: "high" });
  expect(JSON.stringify(expert?.messages)).toContain("Owner uses Python 3.12");
  expect(expert?.tools).toBeUndefined();

  const reply = t.thread.list().at(-1);
  expect(reply?.text).toBe(
    `I'll get Opus to write that.\n\n---\n\n${code}\n\n---\n\nRun it with python3.`,
  );
  const results = JSON.stringify(model.requests[2]?.messages.at(-1)?.content);
  expect(results).toContain("shown to the owner as is");
  expect(JSON.stringify(model.requests[3]?.messages.at(-1)?.content)).toContain(
    "already asked once",
  );
  expect(t.db.query("SELECT model, purpose FROM spend_ledger ORDER BY id").all()).toContainEqual({
    model: "claude-opus-5-5",
    purpose: "expert",
  });
  expect(
    t.events.some((e) => e.type === "message.progress" && e.text.includes("Asking Opus")),
  ).toBe(true);
});

test("on Opus the chat has no ask_opus, keeps its fallback, and a switch starts a new episode", async () => {
  const model = new FakeModel([{ content: [text("one")] }, { content: [text("two")] }]);
  const t = await testApp(model);
  await t.thread.post("first").done;
  t.settings.update({ chatModel: "claude-opus-5-5" });
  t.advance(60_000);
  await t.thread.post("second").done;
  const opus = model.requests[1];
  expect(opus?.model).toBe("claude-opus-5-5");
  expect(opus?.fallbacks).toBe("default");
  expect(opus?.thinking).toMatchObject({ display: "updates" });
  expect(opus?.tools?.some((x) => "name" in x && x.name === "ask_opus")).toBe(false);
  // A fresh episode: one message, opening with the context block.
  expect(opus?.messages.length).toBe(1);
  expect(lastUserText(opus as never)).toContain("Owner: first");
});

test("a task started from the chat keeps what you said, for its approval check", async () => {
  const model = new FakeModel([
    {
      content: [
        toolUse("run_task", { title: "Restart jellyfin", goal: "Restart jellyfin on nas" }),
      ],
    },
    { content: [text("On it.")] },
  ]);
  const work = new FakeModel([
    { content: [toolUse("finish_task", { outcome: "done", summary: "Done.", notify: false })] },
  ]);
  const t = await testApp(model, work);
  await t.thread.post("please restart jellyfin").done;
  await t.tasks.idle();
  const task = t.tasks.list({}).at(-1);
  expect(t.tasks.requestOf(task?.id as number)).toContain("please restart jellyfin");
});

test("commands are a known name after a slash; anything else is a message", () => {
  expect(parseCommand("/new")).toEqual({ name: "new", arg: "" });
  expect(parseCommand("  /Task  check the\nbackups ")).toEqual({
    name: "task",
    arg: "check the\nbackups",
  });
  expect(parseCommand("/etc/hosts is wrong")).toBeNull();
  expect(parseCommand("/newer")).toBeNull();
  expect(parseCommand("say /new")).toBeNull();
  expect(matchingCommands("/").map((c) => c.name)).toEqual(["new", "stop", "task", "remember"]);
  expect(matchingCommands("/re").map((c) => c.name)).toEqual(["remember"]);
  expect(matchingCommands("/remember x")).toEqual([]);
});

test("/new starts a conversation that carries nothing over, and folds the last one", async () => {
  const model = new FakeModel(
    [{ content: [text("one")] }, { content: [text("two")] }],
    ["<recap>Said one.</recap><summary>They said one.</summary>"],
  );
  const t = await testApp(model);
  await t.thread.post("first").done;
  t.db.query("UPDATE episodes SET tainted = 1, tainted_by = 'https://example.com'").run();
  t.advance(60_000);
  await t.thread.post("/new").done;
  // A second /new is the same new conversation.
  await t.thread.post("/new").done;
  await t.thread.post("second").done;

  expect(model.creates.length).toBe(1);
  expect(model.requests[1]?.messages.length).toBe(1);
  const opening = lastUserText(model.requests[1] as never);
  expect(opening).toContain("They said one.");
  expect(opening).not.toContain("Owner: first");
  const episodes = t.db
    .query<{ tainted: number; fresh: number }, []>(
      "SELECT tainted, fresh FROM episodes ORDER BY id",
    )
    .all();
  expect(episodes).toEqual([
    { tainted: 1, fresh: 0 },
    { tainted: 0, fresh: 1 },
  ]);
  const list = t.thread.list();
  expect(list.map((m) => [m.kind, m.text, m.episodeId])).toEqual([
    ["text", "first", 1],
    ["text", "one", 1],
    ["command", "/new", 2],
    ["command", "/new", 2],
    ["text", "second", 2],
    ["text", "two", 2],
  ]);
  const episodesById = Object.fromEntries(t.thread.episodes([1, 2]).map((e) => [e.id, e]));
  expect(threadGroups(list, episodesById).map((g) => g.fold)).toEqual(["Said one.", null]);
});

/** A model that streams until it's stopped. */
class HangingModel extends FakeModel {
  started = Promise.withResolvers<void>();
  override async stream(params: Omit<StreamParams, "stream">, h: StreamHandlers) {
    this.requests.push(structuredClone(params));
    this.started.resolve();
    h.onText?.("Let me think about ");
    return new Promise<never>((_, reject) =>
      h.signal?.addEventListener("abort", () => reject(h.signal?.reason)),
    );
  }
}

test("/stop stops the reply being written; with a number, that task", async () => {
  const model = new HangingModel();
  const t = await testApp(model);
  const reply = t.thread.post("write me an essay");
  await model.started.promise;
  t.thread.post("/stop");
  await reply.done;
  expect(t.thread.list().at(-1)).toMatchObject({ kind: "command", text: "/stop" });
  expect(t.thread.list().at(-2)).toMatchObject({
    text: "Let me think about \n\n---\n\n_Stopped._",
    status: "done",
  });

  await t.thread.post("/stop").done;
  expect(t.thread.list().at(-1)).toMatchObject({
    role: "assistant",
    kind: "command",
    text: "Nothing to stop.",
  });
  await t.thread.post("/stop #99").done;
  expect(t.thread.list().at(-1)?.text).toBe("Task #99 isn't running.");
  // Lines like these are yours already: never unread.
  expect(t.thread.unread()).not.toContain(t.thread.list().at(-1)?.id as number);
});

test("tool calls a stop cut off get a result, so the next message still goes through", async () => {
  const model = new FakeModel([{ content: [text("one")] }, { content: [text("two")] }]);
  const t = await testApp(model);
  await t.thread.post("first").done;
  // What a reply stopped mid-tool leaves behind: the calls, and no results.
  const calls = [
    toolUse("memory_read", { path: "a.md" }, "toolu_a"),
    toolUse("memory_read", { path: "b.md" }, "toolu_b"),
  ];
  t.db
    .query(
      "INSERT INTO episode_turns (episode_id, role, content, created_at) VALUES (1, 'assistant', ?, ?)",
    )
    .run(JSON.stringify(calls), new Date().toISOString());
  await t.thread.post("second").done;

  const messages = model.requests[1]?.messages ?? [];
  expect(messages.at(-2)?.content).toMatchObject(calls);
  const last = messages.at(-1)?.content as { type: string; tool_use_id?: string }[];
  expect(last.slice(0, 2)).toMatchObject([
    { type: "tool_result", tool_use_id: "toolu_a", is_error: true },
    { type: "tool_result", tool_use_id: "toolu_b", is_error: true },
  ]);
  expect(JSON.stringify(last.slice(2))).toContain("second");
});

test("/task runs what you typed as a background task, shown under the line it starts", async () => {
  const model = new FakeModel([{ content: [text("hi")] }, { content: [text("It's running.")] }]);
  const work = new FakeModel([
    { content: [toolUse("finish_task", { outcome: "done", summary: "All fine.", notify: false })] },
  ]);
  const t = await testApp(model, work);
  await t.thread.post("hello").done;
  // The conversation had read something untrusted; what you type yourself isn't.
  t.db.query("UPDATE episodes SET tainted = 1, tainted_by = 'https://example.com'").run();
  await t.thread.post("/task check the backups on the PBS\nand tell me if any failed").done;
  await t.tasks.idle();

  const task = t.tasks.list({}).at(-1);
  expect(task).toMatchObject({ title: "check the backups on the PBS", origin: "chat" });
  expect(task?.tainted).toBeFalsy();
  expect(t.tasks.requestOf(task?.id as number)).toContain("tell me if any failed");
  const line = t.thread.list().at(-1);
  expect(line).toMatchObject({ kind: "command", text: "Started a task.", taskId: task?.id });
  // Its result shows there, not as a card of its own.
  expect(t.thread.list().filter((m) => m.kind === "task")).toEqual([]);

  // The model hears about it with your next message.
  await t.thread.post("how's it going?").done;
  const said = lastUserText(model.requests[1] as never);
  expect(said).toContain("<owner_commands>");
  expect(said).toContain(`Hatbot: Started a task. (task #${task?.id})`);
  expect(said).toContain("how's it going?");

  await t.thread.post("/task").done;
  expect(t.thread.list().at(-1)?.text).toContain("Say what to do");
});

test("/remember saves what you typed to INDEX.md's Notes, word for word", async () => {
  const t = await testApp(new FakeModel());
  await t.thread.post("/remember the NAS is at 192.168.55.120").done;
  await t.thread.post("/remember Jellyfin runs in CT 105").done;
  expect(await t.memory.read("INDEX.md")).toContain(
    "## Notes\n\n- the NAS is at 192.168.55.120\n- Jellyfin runs in CT 105\n",
  );
  expect(t.thread.list().at(-1)).toMatchObject({ kind: "command", text: "Saved to memory." });
  expect(t.events.some((e) => e.type === "memory.committed")).toBe(true);
  expect(t.model.requests.length).toBe(0);
});

test("notes go at the end of the Notes section, made if it's missing", () => {
  expect(withNote("", "a")).toBe("## Notes\n\n- a\n");
  expect(withNote("# Index\n\n- homelab.md\n", "a")).toBe(
    "# Index\n\n- homelab.md\n\n## Notes\n\n- a\n",
  );
  expect(withNote("# Index\n\n## Notes\n\n- a\n\n## Skills\n\n- x\n", "b\nc")).toBe(
    "# Index\n\n## Notes\n\n- a\n- b c\n\n## Skills\n\n- x\n",
  );
  expect(titleOf("short")).toBe("short");
  expect(titleOf("word ".repeat(30))).toBe(`${"word ".repeat(15).trim()}…`);
});
