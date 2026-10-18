import { expect, test } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import { webCalls, webReads } from "../src/agent/tools";
import { costOf } from "../src/spend";
import { FakeModel, text, toolUse } from "./fake-model";
import { requested, testApp, toolNames } from "./helpers";

type Block = Anthropic.Beta.BetaContentBlock;
const search = (query: string): Block[] => [
  { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query } } as Block,
  {
    type: "web_search_tool_result",
    tool_use_id: "srvtoolu_1",
    content: [{ type: "web_search_result", url: "https://example.com", title: "Example" }],
  } as unknown as Block,
];

/** A search run from code the model wrote (dynamic filtering): only the code and its result come back. */
const codeSearch = (code: string, id = "srvtoolu_code"): Block[] => [
  { type: "server_tool_use", id, name: "code_execution", input: { code } } as Block,
  {
    type: "code_execution_tool_result",
    tool_use_id: id,
    content: { type: "encrypted_code_execution_result", encrypted_stdout: "x", return_code: 0 },
  } as unknown as Block,
];

test("the chat searches the web, goes on in the same container after a pause, pays a cent a search, and is tainted by what it read", async () => {
  const chat = new FakeModel([
    {
      content: search("proxmox 9.2 release date"),
      stop_reason: "pause_turn",
      container: "cntr_1",
      usage: { server_tool_use: { web_search_requests: 1 } } as never,
    },
    { content: [text("It came out last week.")] },
  ]);
  const t = await testApp(chat);
  await t.thread.post("when did proxmox 9.2 come out?").done;

  expect(toolNames(chat.requests[0])).toEqual(expect.arrayContaining(["web_search", "web_fetch"]));
  expect(chat.requests[0]).not.toHaveProperty("container");
  expect(chat.requests[1]?.container).toBe("cntr_1");
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
  const [paused] = t.db
    .query<{ model: string; cost_usd: number }, []>(
      "SELECT model, cost_usd FROM spend_ledger ORDER BY id",
    )
    .all();
  const tokens = { input: 1000, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 200 };
  expect(paused?.cost_usd).toBeCloseTo(costOf(paused?.model as string, tokens) + 0.01, 9);
});

test("searches and reads in code the model wrote are found, shown, and taint the chat", async () => {
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

test("a task holds its news while the web tools' code is still running", async () => {
  const running = Promise.withResolvers<void>();
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
      wait: running.promise,
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
  const asked = requested(work);
  const task = t.tasks.createBackgroundTask({ title: "Look", goal: "Look", origin: "chat" });
  await asked;
  t.tasks.tell(task?.id as number, "Monitor back up");
  running.resolve();
  await t.tasks.idle();
  const second = work.requests[1]?.messages.at(-1)?.content as { type: string }[];
  expect(second.map((b) => b.type)).toEqual(["tool_result"]);
  expect(work.requests[1]?.container).toBe("cntr_2");
  // It arrives with the next results instead.
  const third = work.requests[2]?.messages.at(-1)?.content as { type: string; text?: string }[];
  expect(third.map((b) => b.type)).toEqual(["tool_result", "text"]);
  expect(third[1]?.text).toContain("Monitor back up");
});

test("a reply keeps the pages it cites, searched or fetched", async () => {
  const cite = (t: string, citations: unknown[]): Block =>
    ({ type: "text", text: t, citations }) as unknown as Block;
  const chat = new FakeModel([
    {
      content: [
        {
          type: "web_fetch_tool_result",
          tool_use_id: "srvtoolu_f",
          content: {
            type: "web_fetch_result",
            url: "https://pve.proxmox.com/wiki/Roadmap",
            retrieved_at: null,
            content: {
              type: "document",
              title: "Roadmap - Proxmox VE",
              citations: { enabled: true },
              source: { type: "text", media_type: "text/plain", data: "..." },
            },
          },
        } as unknown as Block,
        cite("It's due in December", [
          {
            type: "web_search_result_location",
            url: "https://forum.proxmox.com/t/9-3",
            title: "9.3 release thread",
            cited_text: "December",
            encrypted_index: "x",
          },
          {
            type: "char_location",
            document_index: 0,
            document_title: "Roadmap - Proxmox VE",
            cited_text: "Q4",
            start_char_index: 0,
            end_char_index: 2,
            file_id: null,
          },
        ]),
        cite(", with kernel 7.1.", [
          {
            type: "web_search_result_location",
            url: "https://forum.proxmox.com/t/9-3",
            title: "9.3 release thread",
            cited_text: "7.1",
            encrypted_index: "y",
          },
        ]),
      ],
    },
  ]);
  const t = await testApp(chat);
  await t.thread.post("when is proxmox 9.3 out?").done;
  const sources = [
    { url: "https://forum.proxmox.com/t/9-3", title: "9.3 release thread" },
    { url: "https://pve.proxmox.com/wiki/Roadmap", title: "Roadmap - Proxmox VE" },
  ];
  expect(t.thread.list().at(-1)?.sources).toEqual(sources);
  const done = t.events.find((e) => e.type === "message.done") as { sources?: unknown };
  expect(done.sources).toEqual(sources);
  // A reply that cites nothing has none.
  expect(t.thread.list()[0]).not.toHaveProperty("sources");
});
