import { expect, test } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import { WEB_TOOLS, webCalls, webReads, webTools } from "../src/agent/tools";
import { costOf } from "../src/spend";
import { FakeModel, text, toolUse } from "./fake-model";
import { testApp } from "./helpers";

type Block = Anthropic.Beta.BetaContentBlock;
const search = (query: string): Block[] => [
  { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query } } as Block,
  {
    type: "web_search_tool_result",
    tool_use_id: "srvtoolu_1",
    content: [{ type: "web_search_result", url: "https://example.com", title: "Example" }],
  } as unknown as Block,
];
const toolNames = (req: { tools?: unknown[] } | undefined) =>
  (req?.tools ?? []).map((t) => (t as { name: string }).name);

test("the chat searches the web; what it read taints the conversation", async () => {
  const chat = new FakeModel([
    { content: [...search("proxmox 9.2 release date"), text("It came out last week.")] },
  ]);
  const t = await testApp(chat);
  await t.thread.post("when did proxmox 9.2 come out?").done;

  expect(toolNames(chat.requests[0])).toEqual(expect.arrayContaining(["web_search", "web_fetch"]));
  const lines = t.events
    .filter((e) => e.type === "message.progress")
    .map((e) => (e as { text: string }).text.trim());
  expect(lines).toContain("Searching the web: proxmox 9.2 release date");
  const episode = t.db
    .query<{ tainted: number; tainted_by: string }, []>("SELECT tainted, tainted_by FROM episodes")
    .get();
  expect(episode).toEqual({
    tainted: 1,
    tainted_by: 'Searched the web for "proxmox 9.2 release date"',
  });
  expect(t.thread.list().at(-1)?.text).toBe("It came out last week.");
});

test("each web search is billed at a cent on top of tokens", async () => {
  const t = await testApp();
  const usage = {
    input_tokens: 1000,
    output_tokens: 200,
    server_tool_use: { web_search_requests: 2 },
  };
  const cost = t.spend.recordResponse({ model: "claude-haiku-5-5", purpose: "thread", usage });
  const tokens = { input: 1000, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 200 };
  expect(cost).toBeCloseTo(costOf("claude-haiku-5-5", tokens) + 0.02, 9);
});

test("a task's web reads show on its timeline and taint it", async () => {
  const chat = new FakeModel([
    { content: [toolUse("run_task", { title: "Check release", goal: "Find the release date" })] },
    { content: [text("On it.")] },
    { content: [text("Done.")] },
  ]);
  const work = new FakeModel([
    { content: search("proxmox 9.2"), stop_reason: "pause_turn" },
    {
      content: [toolUse("finish_task", { outcome: "done", summary: "Last week.", notify: false })],
    },
  ]);
  const t = await testApp(chat, work);
  t.thread.post("check the proxmox release");
  await t.thread.idle();
  await t.tasks.idle();
  const [task] = t.tasks.list();
  expect(task?.summary).toBe("Last week.");
  expect(task?.tainted).toBe(true);
  expect(t.tasks.steps(task?.id as number).map((s) => s.detail)).toContain(
    'Searched the web for "proxmox 9.2"',
  );
  expect(toolNames(work.requests[0])).toContain("web_search");
});

/** A search run from code the model wrote (dynamic filtering): only the code and its result come back. */
const codeSearch = (code: string, id = "srvtoolu_code"): Block[] => [
  { type: "server_tool_use", id, name: "code_execution", input: { code } } as Block,
  {
    type: "code_execution_tool_result",
    tool_use_id: id,
    content: { type: "encrypted_code_execution_result", encrypted_stdout: "x", return_code: 0 },
  } as unknown as Block,
];

test("the web tools are the dynamic filtering versions, callable directly or from code", async () => {
  const chat = new FakeModel([{ content: [text("Hi.")] }]);
  const t = await testApp(chat);
  await t.thread.post("hi").done;
  const tools = (chat.requests[0]?.tools ?? []) as unknown as Record<string, unknown>[];
  const search = tools.find((x) => x.name === "web_search");
  const fetch = tools.find((x) => x.name === "web_fetch");
  expect(search).toMatchObject({
    type: "web_search_20260318",
    allowed_callers: ["direct", "code_execution_20260120"],
    response_inclusion: "excluded",
  });
  // The chat's pages can be cited; a task's summary has nowhere to show citations.
  expect(fetch).toMatchObject({ type: "web_fetch_20260318", citations: { enabled: true } });
  expect(WEB_TOOLS.find((x) => "name" in x && x.name === "web_fetch")).not.toHaveProperty(
    "citations",
  );
});

test("web tools say where the owner is by time zone, and fall back to the basic versions", () => {
  const [search] = webTools({ pageTokens: 1000, timeZone: "Europe/Warsaw", env: {} });
  expect(search).toMatchObject({
    user_location: { type: "approximate", timezone: "Europe/Warsaw" },
  });
  // UTC says nothing about where someone is.
  expect(webTools({ pageTokens: 1000, timeZone: "UTC", env: {} })[0]).not.toHaveProperty(
    "user_location",
  );
  const basic = webTools({ pageTokens: 1000, env: { HATBOT_WEB_TOOLS: "basic" } });
  expect(basic.map((x) => x.type)).toEqual(["web_search_20250305", "web_fetch_20250910"]);
  expect(basic[0]).not.toHaveProperty("allowed_callers");
});

test("searches and reads in code the model wrote are found, for taint and the timeline", () => {
  const code = `for q in ["proxmox 9.3 release", 'pve kernel 7.1']:\n    r = web_search({"query": q})\nqs = [web_search(query="ceph squid")]\npage = web_fetch({"url": "https://pve.proxmox.com/wiki/Roadmap"})`;
  expect(webCalls("code_execution", { code })).toEqual([
    { search: "ceph squid" },
    { read: "https://pve.proxmox.com/wiki/Roadmap" },
  ]);
  // Queries in a list the code loops over aren't in a call: it still counts as a search.
  expect(webCalls("code_execution", { code: "for q in qs: web_search({'query': q})" })).toEqual([
    { search: "" },
  ]);
  expect(webCalls("code_execution", { code: "print(sum([1, 2]))" })).toEqual([]);
  expect(webReads(codeSearch(`web_search({"query": "zfs 2.4"})`))).toEqual([
    'Searched the web for "zfs 2.4"',
  ]);
  // A call the code made, returned in full, counts once: not again for the code around it.
  const nested = [
    ...codeSearch(`web_search({"query": "zfs 2.4"})`, "srvtoolu_c"),
    {
      type: "server_tool_use",
      id: "srvtoolu_n",
      name: "web_search",
      input: { query: "zfs 2.4" },
      caller: { type: "code_execution_20260120", tool_id: "srvtoolu_c" },
    } as Block,
  ];
  expect(webReads(nested)).toEqual(['Searched the web for "zfs 2.4"']);
});

test("the chat's search from code shows its queries and taints the conversation", async () => {
  const chat = new FakeModel([
    {
      content: [
        ...codeSearch(
          `a = web_search({"query": "proxmox 9.3"})\nb = web_search({"query": "pve 9.3 changelog"})`,
        ),
        text("Next month."),
      ],
    },
  ]);
  const t = await testApp(chat);
  await t.thread.post("when is proxmox 9.3 out?").done;
  const lines = t.events
    .filter((e) => e.type === "message.progress")
    .map((e) => (e as { text: string }).text.trim());
  expect(lines).toContain("Searching the web: proxmox 9.3, pve 9.3 changelog");
  const episode = t.db.query<{ tainted_by: string }, []>("SELECT tainted_by FROM episodes").get();
  expect(episode?.tainted_by).toBe('Searched the web for "proxmox 9.3"');
});

test("a paused reply goes on in the same container", async () => {
  const chat = new FakeModel([
    {
      content: codeSearch(`web_search({"query": "a"})`),
      stop_reason: "pause_turn",
      container: "cntr_1",
    },
    { content: [text("Found it.")] },
  ]);
  const t = await testApp(chat);
  await t.thread.post("look it up").done;
  expect(chat.requests[0]).not.toHaveProperty("container");
  expect(chat.requests[1]?.container).toBe("cntr_1");
});

test("a task holds its news while the web tools' code is still running", async () => {
  let started = () => {};
  const running = new Promise<void>((r) => {
    started = r;
  });
  const work = new FakeModel([
    {
      content: [
        // Code still running: no result yet.
        {
          type: "server_tool_use",
          id: "srvtoolu_w",
          name: "code_execution",
          input: { code: "x" },
        } as Block,
        toolUse("memory_list", {}),
      ],
      container: "cntr_2",
      wait: running,
    },
    {
      content: [
        {
          type: "code_execution_tool_result",
          tool_use_id: "srvtoolu_w",
          content: {
            type: "encrypted_code_execution_result",
            encrypted_stdout: "x",
            return_code: 0,
          },
        } as unknown as Block,
        toolUse("memory_list", {}),
      ],
    },
    {
      content: [toolUse("finish_task", { outcome: "done", summary: "Done.", notify: false })],
    },
  ]);
  const t = await testApp(new FakeModel(), work);
  const task = t.tasks.createBackgroundTask({ title: "Look", goal: "Look", origin: "chat" });
  await Bun.sleep(20);
  t.tasks.tell(task?.id as number, "Monitor back up");
  started();
  await t.tasks.idle();
  const second = work.requests[1]?.messages.at(-1)?.content as { type: string }[];
  expect(second.map((b) => b.type)).toEqual(["tool_result"]);
  expect(work.requests[1]?.container).toBe("cntr_2");
  // It arrives with the next results instead.
  const third = work.requests[2]?.messages.at(-1)?.content as { type: string; text?: string }[];
  expect(third.map((b) => b.type)).toEqual(["tool_result", "text"]);
  expect(third[1]?.text).toContain("Monitor back up");
});
