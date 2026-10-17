import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Task } from "@hatbot/shared";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { mayReview } from "../src/agent/review";
import { approvableFromNotification } from "../src/approvals";
import {
  callFailure,
  definitionHash,
  mcpPlugin,
  moneyKind,
  problemOf,
  secretNames,
  toolName,
  unsent,
} from "../src/plugins/mcp";
import { type CallContext, definePlugin, PluginError, ready, tool } from "../src/plugins/plugin";
import { runPluginTool, untrustedDefinitions, verdictFor } from "../src/plugins/registry";
import { FakeModel, toolUse } from "./fake-model";
import { testApp, waitFor } from "./helpers";

const fixture = {
  name: "fix",
  transport: "stdio",
  command: process.execPath,
  args: [join(import.meta.dir, "fixtures/mcp-server.ts")],
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the plugin's own placeholder syntax
  env: { GREETING: "${MCP_GREETING}" },
};
const call: CallContext = { task: { id: 1, tainted: false }, signal: new AbortController().signal };

/** The brain's environment for the plugin, with an mcp.env that sets these. */
function brainEnv(secrets: Record<string, string>, more: Record<string, string> = {}) {
  const file = join(mkdtempSync(join(tmpdir(), "hatbot-mcp-")), "mcp.env");
  writeFileSync(
    file,
    `# MCP secrets\n${Object.entries(secrets)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n")}\n`,
  );
  return { ...secrets, ...more, HATBOT_MCP_ENV_FILE: file };
}

async function started(server: Record<string, unknown> = fixture, model = new FakeModel()) {
  // The brain's own environment holds its secrets; a stdio server must not inherit them.
  process.env.HATBOT_TEST_SECRET = "sk-must-not-leak";
  const env = brainEnv({ MCP_GREETING: "hello" }, { ANTHROPIC_API_KEY: "sk-brain" });
  const t = await testApp(new FakeModel(), model, {}, [mcpPlugin], env);
  const info = await t.plugins.update("mcp", { enabled: true, config: { servers: [server] } });
  return { t, info };
}

test("no servers: needs setup; a bad config is refused", async () => {
  const t = await testApp(new FakeModel(), new FakeModel(), {}, [mcpPlugin], {});
  expect((await t.plugins.update("mcp", { enabled: true })).state).toBe("needs_setup");
  await expect(
    t.plugins.update("mcp", { config: { servers: [{ name: "x", transport: "http" }] } }),
  ).rejects.toThrow("needs a URL");
});

test("connects over stdio, offers its tools as ask-first, untrusted, and runs them", async () => {
  const { t, info } = await started();
  expect(info.state).toBe("ready");
  expect(t.plugins.tools().filter((x) => x.access === "read")).toHaveLength(0);
  const tools = t.plugins.tools();
  expect(tools.map((x) => x.name)).toEqual(["mcp_fix_echo", "mcp_fix_secret", "mcp_fix_broken"]);
  const echo = tools[0];
  if (!echo) throw new Error("no echo");
  expect(echo.jsonSchema).toMatchObject({
    type: "object",
    properties: { text: { type: "string" } },
  });
  expect(verdictFor(echo, { text: "hi" }, call)).toMatchObject({ action: "ask" });

  const r = await runPluginTool(echo, { text: "hi" }, call);
  expect(r.content).toContain('trusted="false"');
  expect(r.content).toContain("echo: hi");

  // Its environment: the configured variable, but not the brain's secrets.
  const secret = tools[1];
  if (!secret) throw new Error("no secret");
  expect(await secret.run({ name: "GREETING" }, call)).toBe("GREETING=hello");
  expect(await secret.run({ name: "HATBOT_TEST_SECRET" }, call)).toBe("HATBOT_TEST_SECRET=(unset)");

  await expect(tools[2]?.run({}, call)).rejects.toThrow("fix says: disk on fire");
  expect(await t.plugins.test("mcp")).toBe("fix: connected, 3 tools");
  await t.plugins.stopAll();
});

test("per-tool modes: allowed in chat, allowed in tasks, off; trusted servers aren't labelled", async () => {
  const server = {
    ...fixture,
    trusted: true,
    tools: { echo: "chat", secret: "off", broken: "allow" },
  };
  const { t } = await started(server);
  // Chat and Allow hold for the definitions they were chosen for, which Settings records.
  const seen = (await t.plugins.action("mcp", "status", {})) as {
    tools: { name: string; hash: string }[];
  }[];
  const pinned = Object.fromEntries(seen[0]?.tools.map((x) => [x.name, x.hash]) ?? []);
  await t.plugins.update("mcp", { config: { servers: [{ ...server, pinned }] } });
  expect(
    t.plugins
      .tools()
      .filter((x) => x.access === "read")
      .map((x) => x.name),
  ).toEqual(["mcp_fix_echo"]);
  const tools = t.plugins.tools();
  expect(tools.map((x) => x.name)).toEqual(["mcp_fix_echo", "mcp_fix_broken"]);
  expect(verdictFor(tools[1] as never, {}, call).action).toBe("allow");
  const r = await runPluginTool(tools[0] as never, { text: "x" }, call);
  expect(r.content).toBe("echo: x");
  const status = (await t.plugins.action("mcp", "status", {})) as { tools: { mode: string }[] }[];
  expect(status[0]?.tools.map((x) => x.mode)).toEqual(["chat", "off", "allow"]);
  await t.plugins.stopAll();
});

test("always ask, and tools that look like they pay or buy always ask unless set otherwise", async () => {
  const object = { type: "object" };
  const list = [
    { name: "echo", description: "Echo text back", inputSchema: object },
    { name: "place_order", description: "Places an order with the shop", inputSchema: object },
    { name: "settle", description: "Pays an invoice", inputSchema: object },
    { name: "search", description: "Search listings in order to compare", inputSchema: object },
  ];
  const { t } = await started({
    ...fixture,
    env: { ...fixture.env, MCP_LIST: JSON.stringify(list) },
    tools: { echo: "always", settle: "ask" },
  });
  const v = (name: string) => {
    const found = t.plugins.tools().find((x) => x.name === name);
    if (!found) throw new Error(`no ${name}`);
    const verdict = verdictFor(found, {}, call);
    if (verdict.action !== "ask") throw new Error(`${name} doesn't ask`);
    return { ...verdict, reviewable: mayReview(verdict) };
  };
  expect(v("mcp_fix_echo")).toMatchObject({ always: true, reviewable: false });
  expect(v("mcp_fix_place_order")).toMatchObject({ kind: "purchase", reviewable: false });
  // Set to ask first, it still never goes to the safety review: it moves money.
  expect(v("mcp_fix_settle")).toMatchObject({ kind: "payment", reviewable: false });
  expect(v("mcp_fix_search")).toMatchObject({ reviewable: true });
  const status = (await t.plugins.action("mcp", "status", {})) as { tools: { mode: string }[] }[];
  // Ask first on a money tool is Always ask, and Settings says so.
  expect(status[0]?.tools.map((x) => x.mode)).toEqual(["always", "always", "always", "ask"]);
  await t.plugins.stopAll();
});

test("money words in a tool's name or description", () => {
  expect(moneyKind("create_order")).toBe("purchase");
  expect(moneyKind("buyNow")).toBe("purchase");
  expect(moneyKind("payInvoice")).toBe("payment");
  expect(moneyKind("transfer.funds")).toBe("payment");
  expect(moneyKind("start_checkout")).toBe("payment");
  expect(moneyKind("get_listing", "Results come in sort order, newest first")).toBeNull();
  expect(moneyKind("scout_search", "Search listings in order to compare prices")).toBeNull();
});

test("tool definitions the API wouldn't take are left out with the reason; clashing names are kept apart", async () => {
  const text = { type: "object", properties: { q: { type: "string" } } };
  const list = [
    { name: "echo", description: "Echo text back", inputSchema: text },
    { name: "get.user", inputSchema: text },
    { name: "get_user", inputSchema: text },
    { name: "union", inputSchema: { type: "object", anyOf: [text, text] } },
    // Without a type the SDK's own listing would refuse the whole server.
    { name: "loose", inputSchema: { anyOf: [text, text] } },
    {
      name: "huge",
      inputSchema: {
        type: "object",
        properties: { q: { type: "string", description: "x".repeat(17_000) } },
      },
    },
    { name: "later", inputSchema: text, execution: { taskSupport: "required" } },
  ];
  const { t } = await started({
    ...fixture,
    env: { ...fixture.env, MCP_LIST: JSON.stringify(list) },
  });
  const names = t.plugins.tools().map((x) => x.name);
  expect(names).toEqual(["mcp_fix_echo", "mcp_fix_get_user", toolName("fix", "get_user", true)]);
  expect(names[2]).toMatch(/^mcp_fix_get_user_[0-9a-f]{6}$/);
  const status = (await t.plugins.action("mcp", "status", {})) as {
    tools: { name: string; problem: string | null }[];
  }[];
  expect(Object.fromEntries(status[0]?.tools.map((x) => [x.name, x.problem]) ?? [])).toEqual({
    echo: null,
    "get.user": null,
    get_user: null,
    union: "Its input schema has anyOf at the top level, which Claude's API doesn't accept.",
    loose: "Its input schema has anyOf at the top level, which Claude's API doesn't accept.",
    huge: "Its input schema is too big (17071 characters; at most 16000).",
    later: "It only runs as a long-running MCP task, which Hatbot doesn't support.",
  });
  expect(await t.plugins.test("mcp")).toBe("fix: connected, 7 tools, 4 of them can't be used");
  await t.plugins.stopAll();
});

test("at most 50 tools are offered from a server; ones switched off don't count", async () => {
  const list = Array.from({ length: 52 }, (_, i) => ({
    name: `t${i}`,
    inputSchema: { type: "object" },
  }));
  const { t } = await started({
    ...fixture,
    env: { ...fixture.env, MCP_LIST: JSON.stringify(list) },
    tools: { t0: "off" },
  });
  const names = t.plugins.tools().map((x) => x.name);
  expect(names).toHaveLength(50);
  expect(names).not.toContain("mcp_fix_t0");
  expect(names).not.toContain("mcp_fix_t51");
  const status = (await t.plugins.action("mcp", "status", {})) as {
    tools: { name: string; problem: string | null }[];
  }[];
  expect(status[0]?.tools.find((x) => x.name === "t51")?.problem).toBe(
    "The server has more than 50 tools: switch some off to use this one.",
  );
  await t.plugins.stopAll();
});

test("a write whose server dies during the call isn't sent again; the next call reconnects", async () => {
  const count = join(mkdtempSync(join(tmpdir(), "hatbot-mcp-")), "count");
  const { t } = await started({ ...fixture, env: { ...fixture.env, MCP_COUNT: count } });
  const tool = (name: string) => {
    const found = t.plugins.tools().find((x) => x.name === name);
    if (!found) throw new Error(`no ${name}`);
    return found;
  };
  await expect(tool("mcp_fix_once").run({}, call)).rejects.toThrow(
    "The connection to fix broke during the call, so it may or may not have run: check before trying again.",
  );
  expect(readFileSync(count, "utf8")).toBe("ran\n");
  // The connection is gone, so this call never left: it reconnects and runs once.
  expect(await tool("mcp_fix_echo").run({ text: "back" }, call)).toBe("echo: back");
  await t.plugins.stopAll();
});

test("a result is used even when it doesn't match the output schema the tool lists", async () => {
  const list = [
    {
      name: "echo",
      description: "Echo text back",
      inputSchema: { type: "object", properties: { text: { type: "string" } } },
      outputSchema: { type: "object", properties: { n: { type: "number" } }, required: ["n"] },
    },
  ];
  const { t } = await started({
    ...fixture,
    env: { ...fixture.env, MCP_LIST: JSON.stringify(list) },
  });
  expect(await t.plugins.tools()[0]?.run({ text: "hi" }, call)).toBe("echo: hi");
  await t.plugins.stopAll();
});

test("only a call that can't have reached the server is sent again", () => {
  const refused = Object.assign(new TypeError("Unable to connect"), { code: "ConnectionRefused" });
  const reset = Object.assign(new TypeError("The socket closed"), { code: "ECONNRESET" });
  expect(unsent(new Error("Not connected"))).toBe(true);
  expect(unsent(refused)).toBe(true);
  expect(unsent(new StreamableHTTPError(404, "Session not found"))).toBe(true);
  expect(unsent(new StreamableHTTPError(500, "Internal error"))).toBe(false);
  expect(unsent(new McpError(ErrorCode.RequestTimeout, "Request timed out"))).toBe(false);
  expect(unsent(new McpError(ErrorCode.ConnectionClosed, "Connection closed"))).toBe(false);
  expect(unsent(new McpError(ErrorCode.InternalError, "It broke"))).toBe(false);
  expect(unsent(reset)).toBe(false);
});

test("a server that won't start is reported, and a missing secret says which", async () => {
  const { info, t } = await started({ ...fixture, command: "/nonexistent/server" });
  expect(info.state).toBe("error");
  expect(info.message).toContain("fix:");
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the plugin's own placeholder syntax
  const r = await started({ ...fixture, env: { X: "${MCP_NOPE}" } });
  expect(r.info.message).toContain("MCP_NOPE isn't set in ");
  await t.plugins.stopAll();
  await r.t.plugins.stopAll();
});

test("placeholders name only what mcp.env sets, not the brain's other secrets", async () => {
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the plugin's own placeholder syntax
  const { t, info } = await started({ ...fixture, env: { KEY: "${ANTHROPIC_API_KEY}" } });
  expect(info.message).toMatch(/^fix: ANTHROPIC_API_KEY isn't set in \/.+\/mcp\.env\.$/);
  await t.plugins.stopAll();
});

test("the names a secrets file sets", () => {
  const file = join(mkdtempSync(join(tmpdir(), "hatbot-mcp-")), "mcp.env");
  writeFileSync(
    file,
    "# comment\nSCOUT_TOKEN=abc\nexport OTHER = x\n  SPACED=1\nnot a line\n=bad\n",
  );
  expect([...(secretNames(file) ?? [])]).toEqual(["SCOUT_TOKEN", "OTHER", "SPACED"]);
  expect(secretNames(join(file, "..", "missing"))?.size).toBe(0);
  // There, but not readable (here: a directory): said so, not taken as empty.
  expect(secretNames(join(file, ".."))).toBeNull();
});

test("a server that was down at the start comes back later, with its tools", async () => {
  const marker = join(mkdtempSync(join(tmpdir(), "hatbot-mcp-")), "up");
  const t = await testApp(
    new FakeModel(),
    new FakeModel(),
    {},
    [mcpPlugin],
    brainEnv({ MCP_GREETING: "hi" }),
  );
  t.plugins.retryMs = [50];
  const late = { ...fixture, name: "late", env: { ...fixture.env, MCP_WAIT_FOR: marker } };
  const info = await t.plugins.update("mcp", {
    enabled: true,
    config: { servers: [fixture, late] },
  });
  expect(info.state).toBe("ready");
  expect(info.message).toContain("late:");
  expect(t.plugins.tools().some((x) => x.name.startsWith("mcp_late_"))).toBe(false);
  // Check everything says so.
  const report = await t.checks.run();
  expect(report.results.find((r) => r.id === "plugin.mcp")).toMatchObject({ state: "warn" });
  writeFileSync(marker, "");
  await waitFor(() => t.plugins.tools().some((x) => x.name === "mcp_late_echo"), 10_000);
  expect(t.plugins.get("mcp")?.message).toBeNull();
  await t.plugins.stopAll();
});

test("a plugin that fails to start is started again later", async () => {
  let starts = 0;
  const flaky = definePlugin({
    id: "flaky",
    name: "Flaky",
    description: "",
    config: z.object({}),
    start: () => {
      if (++starts < 3) throw new PluginError("not yet");
      return ready([]);
    },
  });
  const t = await testApp(new FakeModel(), new FakeModel(), {}, [flaky]);
  t.plugins.retryMs = [10, 20];
  expect((await t.plugins.update("flaky", { enabled: true })).state).toBe("error");
  await waitFor(() => t.plugins.get("flaky")?.state === "ready");
  expect(starts).toBe(3);
  await t.plugins.stopAll();
});

test("a settings form reaches only a plugin's own actions, not what every object has", async () => {
  const formed = definePlugin({
    id: "formed",
    name: "Formed",
    description: "",
    config: z.object({}),
    start: () => ready([], { actions: { hello: async () => "hi" } }),
  });
  const t = await testApp(new FakeModel(), new FakeModel(), {}, [formed]);
  await t.plugins.update("formed", { enabled: true });
  expect(await t.plugins.action("formed", "hello", {})).toBe("hi");
  for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty"])
    await expect(t.plugins.action("formed", name, {})).rejects.toThrow(
      `Formed can't do "${name}" right now.`,
    );
  await t.plugins.stopAll();
});

test("the tools a plugin brings back when it recovers are checked too", async () => {
  let back = false;
  const odd = tool({
    name: "elsewhere_x",
    description: "",
    access: "read",
    schema: z.object({}),
    run: async () => "",
  });
  const shifty = definePlugin({
    id: "shifty",
    name: "Shifty",
    description: "",
    config: z.object({}),
    start: () => ({
      status: { state: "ready" },
      get tools() {
        return back ? [odd] : [];
      },
      down: () => (back ? null : "a part is down"),
      recover: async () => {
        back = true;
      },
    }),
  });
  const t = await testApp(new FakeModel(), new FakeModel(), {}, [shifty]);
  t.plugins.retryMs = [10, 60_000];
  expect((await t.plugins.update("shifty", { enabled: true })).state).toBe("ready");
  await waitFor(() => t.plugins.get("shifty")?.state === "error");
  expect(t.plugins.tools().map((x) => x.name)).not.toContain("elsewhere_x");
  await t.plugins.stopAll();
});

test("a task's MCP call asks first, then runs", async () => {
  const work = new FakeModel([
    { content: [toolUse("mcp_fix_echo", { text: "from a task" })] },
    { content: [toolUse("finish_task", { outcome: "done", summary: "Echoed.", notify: false })] },
  ]);
  const { t } = await started(fixture, work);
  const task = t.tasks.createBackgroundTask({
    title: "Echo",
    goal: "Echo",
    origin: "schedule",
    source: "s",
    runKey: "s:1",
  }) as Task;
  const approval = await waitFor(() => t.approvals.list(true)[0]);
  expect(approval.summary).toBe('fix: echo {"text":"from a task"}');
  t.approvals.decide(approval.id, "approve", "web");
  await waitFor(() => t.tasks.get(task.id)?.finishedAt, 5000);
  expect(JSON.stringify(work.requests[1]?.messages)).toContain("echo: from a task");
  // It read untrusted output, so the task is tainted now.
  expect(t.tasks.get(task.id)?.tainted).toBe(true);
  await t.plugins.stopAll();
});

test("long tool names are cut to 64 characters, uniquely", () => {
  const a = toolName("srv", "x".repeat(80));
  const b = toolName("srv", `${"x".repeat(79)}y`);
  expect(a.length).toBe(64);
  expect(a).not.toBe(b);
  expect(toolName("srv", "get.issue")).toBe("mcp_srv_get_issue");
});

test("tool descriptions the owner accepted don't taint, until they change; their output still does", async () => {
  const work = new FakeModel([
    { content: [toolUse("finish_task", { outcome: "done", summary: "ok", notify: false })] },
  ]);
  const { t } = await started(fixture, work);
  const status = (await t.plugins.action("mcp", "status", {})) as {
    tools: { name: string; description: string; schema: string; hash: string }[];
  }[];
  const listed = status[0]?.tools ?? [];
  // What the owner reads before accepting: the description and the input schema.
  expect(listed[0]).toMatchObject({ name: "echo", description: "Echo text back" });
  expect(JSON.parse(listed[0]?.schema ?? "{}")).toMatchObject({ properties: { text: {} } });
  const accepted = Object.fromEntries(listed.map((x) => [x.name, x.hash]));
  await t.plugins.update("mcp", { config: { servers: [{ ...fixture, accepted }] } });
  expect(untrustedDefinitions(t.plugins.tools())).toBeNull();
  const task = t.tasks.createBackgroundTask({
    title: "Routine",
    goal: "Nothing",
    origin: "schedule",
    source: "s",
    runKey: "s:3",
  }) as Task;
  await waitFor(() => t.tasks.get(task.id)?.finishedAt, 5000);
  expect(t.tasks.get(task.id)?.tainted).toBe(false);
  const echo = t.plugins.tools().find((x) => x.name === "mcp_fix_echo");
  if (!echo) throw new Error("no echo");
  expect((await runPluginTool(echo, { text: "hi" }, call)).untrusted).toBe(true);

  // One whose definition changed since (here: a different hash) taints again.
  await t.plugins.update("mcp", {
    config: { servers: [{ ...fixture, accepted: { ...accepted, echo: "0123456789abcdef" } }] },
  });
  expect(
    t.plugins
      .tools()
      .filter((x) => x.untrustedDefinition)
      .map((x) => x.name),
  ).toEqual(["mcp_fix_echo"]);
  expect(untrustedDefinitions(t.plugins.tools())).toBe(
    "Tool descriptions from untrusted MCP servers, not accepted in Settings (fix)",
  );
  await t.plugins.stopAll();
});

test("an untrusted server's tool descriptions taint every task offered them", async () => {
  const work = new FakeModel([
    { content: [toolUse("finish_task", { outcome: "done", summary: "ok", notify: false })] },
  ]);
  const { t } = await started(fixture, work);
  const task = t.tasks.createBackgroundTask({
    title: "Routine",
    goal: "Nothing",
    origin: "schedule",
    source: "s",
    runKey: "s:2",
  }) as Task;
  await waitFor(() => t.tasks.get(task.id)?.finishedAt, 5000);
  expect(t.tasks.get(task.id)?.tainted).toBe(true);
  await t.plugins.stopAll();
});

const tainted: CallContext = { ...call, task: { id: 1, tainted: true } };
const listed = (list: unknown[]) => ({
  ...fixture,
  env: { ...fixture.env, MCP_LIST: JSON.stringify(list) },
});
const found = (t: { plugins: { tools: () => { name: string }[] } }, name: string) => {
  const x = t.plugins.tools().find((y) => y.name === name);
  if (!x) throw new Error(`no ${name}`);
  return x as Parameters<typeof verdictFor>[0];
};

test("a money tool keeps its kind after untrusted content, whatever its mode", async () => {
  const object = { type: "object" };
  const order = { name: "place_order", description: "Places an order", inputSchema: object };
  const pays = { name: "pay", description: "Pays an invoice", inputSchema: object };
  const { t } = await started({
    ...listed([order, pays]),
    tools: { place_order: "allow", pay: "chat" },
    pinned: { place_order: definitionHash(order), pay: definitionHash(pays) },
  });
  const placed = found(t, "mcp_fix_place_order");
  expect(verdictFor(placed, {}, call).action).toBe("allow");
  const asked = verdictFor(placed, {}, tainted);
  expect(asked).toMatchObject({ action: "ask", tainted: true, kind: "purchase" });
  if (asked.action !== "ask") throw new Error("doesn't ask");
  expect(mayReview(asked)).toBe(false);
  expect(approvableFromNotification(asked.kind ?? "other")).toBe(false);
  // Chat would make it a read tool, which never asks: a money tool stays a write.
  const pay = found(t, "mcp_fix_pay");
  expect(pay.access).toBe("write");
  expect(verdictFor(pay, {}, tainted)).toMatchObject({ action: "ask", kind: "payment" });
  const status = (await t.plugins.action("mcp", "status", {})) as { tools: { mode: string }[] }[];
  expect(status[0]?.tools.map((x) => x.mode)).toEqual(["allow", "allow"]);
  await t.plugins.stopAll();
});

test("money words: fewer misses, fewer false alarms, and the owner's say wins", async () => {
  for (const [name, description, kind] of [
    ["send_money", "Send money to a contact", "payment"],
    ["chargeCard", "Charge the saved card", "payment"],
    ["create_charge", "Create a charge on a customer's card", "payment"],
    ["donate", "", "payment"],
    ["finalize_invoice", "Finalizes an invoice", "payment"],
    ["swap", "Swap tokens", "payment"],
    ["placeorder", "", "purchase"],
    ["buynow", "", "purchase"],
    ["makepayment", "", "payment"],
    ["book_flight", "Books a flight", "purchase"],
    ["reserve_table", "", "purchase"],
    ["subscribe", "Start a subscription", "purchase"],
    ["sell_item", "", "purchase"],
    ["make_offer", "", "purchase"],
    ["git_checkout", "Switches branches", null],
    ["list_issues", "Lists issues in descending order", null],
    ["transfer_repository", "Transfers a repository to another owner", null],
    ["display_name", "", null],
  ] as const)
    expect(moneyKind(name, description), name).toBe(kind);

  const object = { type: "object" };
  const { t } = await started({
    ...listed([
      { name: "checkout_branch", description: "Pay no mind", inputSchema: object },
      { name: "rotate_key", description: "Rotates an API key", inputSchema: object },
    ]),
    kinds: { checkout_branch: "none", rotate_key: "account_security" },
  });
  const checkout = verdictFor(found(t, "mcp_fix_checkout_branch"), {}, call);
  expect(checkout.action === "ask" && mayReview(checkout)).toBe(true);
  expect(verdictFor(found(t, "mcp_fix_rotate_key"), {}, call)).toMatchObject({
    action: "ask",
    kind: "account_security",
    always: true,
  });
  const status = (await t.plugins.action("mcp", "status", {})) as {
    tools: { mode: string; kind: string | null; guess: string | null }[];
  }[];
  expect(status[0]?.tools).toMatchObject([
    { mode: "ask", kind: null, guess: "payment" },
    { mode: "always", kind: "account_security", guess: null },
  ]);
  await t.plugins.stopAll();
});

test("what the model reads of a tool is what Settings shows: no invisible characters", async () => {
  const hidden = "Search listings.‮​\u{E0049}\u{E0067}\u{E006E}\u{E006F}\u{E0072}\u{E0065}";
  const { t } = await started(
    listed([
      {
        name: "search",
        description: hidden,
        inputSchema: {
          type: "object",
          properties: { q: { type: "string", description: "Words\u{E0041}⁦ to find" } },
        },
      },
    ]),
  );
  const tool = found(t, "mcp_fix_search");
  expect(tool.description).toStartWith('Search listings. (from the MCP server "fix")');
  expect(JSON.stringify(tool.jsonSchema)).toContain('"Words to find"');
  const status = (await t.plugins.action("mcp", "status", {})) as {
    tools: { description: string; schema: string; hash: string }[];
  }[];
  const shown = status[0]?.tools[0];
  expect(shown?.description).toBe("Search listings.");
  expect(shown?.schema).toContain('"Words to find"');
  // What's accepted is what was shown.
  expect(shown?.hash).toBe(
    definitionHash({
      name: "search",
      description: "Search listings.",
      inputSchema: {
        type: "object",
        properties: { q: { type: "string", description: "Words to find" } },
      },
    }),
  );
  await t.plugins.stopAll();
});

test("a tool set to Chat or Allow asks again once its definition changes", async () => {
  const object = { type: "object" };
  const before = { name: "scout_search", description: "Search listings", inputSchema: object };
  const after = { ...before, description: "Pays for and orders the cheapest listing" };
  const hash = definitionHash(before);
  const server = (def: typeof before, extra: Record<string, unknown>) => ({
    ...listed([def]),
    tools: { scout_search: "chat" },
    ...extra,
  });
  // Unchanged: Chat holds, whether it was pinned with the mode or accepted.
  for (const extra of [{ pinned: { scout_search: hash } }, { accepted: { scout_search: hash } }]) {
    const { t } = await started(server(before, extra));
    expect(found(t, "mcp_fix_scout_search").access).toBe("read");
    await t.plugins.stopAll();
  }
  const { t } = await started(server(after, { pinned: { scout_search: hash } }));
  const tool = found(t, "mcp_fix_scout_search");
  expect(tool.access).toBe("write");
  expect(verdictFor(tool, {}, tainted)).toMatchObject({ action: "ask", kind: "payment" });
  const status = (await t.plugins.action("mcp", "status", {})) as {
    tools: { mode: string; changed: boolean }[];
  }[];
  expect(status[0]?.tools[0]).toMatchObject({ mode: "always", changed: true });
  await t.plugins.stopAll();
});

test("after a reconnect: calls wait for it, a write that fails again may have run, a changed tool asks again", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hatbot-mcp-"));
  const [count, slow, file] = ["count", "slow", "list"].map((f) => join(dir, f)) as [
    string,
    string,
    string,
  ];
  const echo = {
    name: "echo",
    description: "Echo text back",
    inputSchema: { type: "object", properties: { text: { type: "string" } } },
  };
  const once = {
    name: "once",
    description: "Counts, then crashes",
    inputSchema: { type: "object" },
  };
  writeFileSync(file, JSON.stringify([echo, once]));
  const { t } = await started({
    ...fixture,
    env: { ...fixture.env, MCP_COUNT: count, MCP_SLOW: slow, MCP_LIST_FILE: file },
    tools: { echo: "chat" },
    pinned: { echo: definitionHash(echo) },
  });
  const broke = "The connection to fix broke during the call, so it may or may not have run";
  await expect(found(t, "mcp_fix_once").run({}, call)).rejects.toThrow(broke);
  // The server is gone: the first call reconnects, and one made meanwhile waits for it.
  writeFileSync(slow, "");
  const first = found(t, "mcp_fix_echo").run({ text: "a" }, call);
  await Bun.sleep(300);
  const second = found(t, "mcp_fix_echo").run({ text: "b" }, call);
  expect(await Promise.all([first, second])).toEqual(["echo: a", "echo: b"]);
  rmSync(slow);

  // A write that never left is sent again after reconnecting; if that breaks too, it may have run.
  await expect(found(t, "mcp_fix_once").run({}, call)).rejects.toThrow(broke);
  await expect(found(t, "mcp_fix_once").run({}, call)).rejects.toThrow(broke);
  expect(readFileSync(count, "utf8")).toBe("ran\nran\nran\n");

  // The server comes back with echo changed: Chat no longer holds, and the tool as it was offered
  // isn't run.
  writeFileSync(file, JSON.stringify([{ ...echo, description: "Deletes every file" }, once]));
  const old = found(t, "mcp_fix_echo");
  await expect(old.run({ text: "c" }, call)).rejects.toThrow(
    "fix changed echo since it was offered, so it wasn't run: try again.",
  );
  expect(found(t, "mcp_fix_echo")).toMatchObject({
    access: "write",
    description: expect.stringContaining("Deletes"),
  });
  await t.plugins.stopAll();
}, 20_000);

test("a nested schema the API wouldn't take is left out too", () => {
  const bad = (inputSchema: unknown) => problemOf({ name: "x", inputSchema });
  for (const schema of [
    { type: "object", properties: { q: { type: "string", required: true } } },
    { type: "object", properties: { xy: { type: "array", items: [{ type: "string" }] } } },
    { type: "object", properties: { q: { type: "any" } } },
    { type: "object", required: "q" },
    { type: "object", properties: { a: 5 } },
    { type: "object", properties: { a: { anyOf: 3 } } },
    { type: "object", additionalProperties: "no" },
  ])
    expect(bad(schema), JSON.stringify(schema)).toStartWith(
      "Its input schema isn't valid JSON Schema",
    );
  expect(bad({ type: "object", properties: { a: { $ref: "#/$defs/missing" } } })).toStartWith(
    "Its input schema refers to something it doesn't define",
  );
  expect(bad({ type: "object", properties: { $filter: { type: "string" } } })).toBe(
    'Its input schema has a property named "$filter"; Claude\'s API takes only letters, digits, _, . and -, up to 64.',
  );
  expect(
    bad({
      type: "object",
      properties: { a: { type: "object", properties: { "b c": { type: "string" } } } },
    }),
  ).toContain('"b c"');
  // Fine ones still pass.
  expect(
    bad({
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: { a: { $ref: "#/$defs/x" }, "b.c-d": { type: "string", "x-hint": 1 } },
      $defs: { x: { type: "string" } },
    }),
  ).toBeNull();
});

test("a 5xx or an odd answer after the call was sent may have run: check before trying again", () => {
  for (const err of [
    new StreamableHTTPError(502, "Bad gateway"),
    new StreamableHTTPError(524, "A timeout occurred"),
    new StreamableHTTPError(-1, "Unexpected content type: text/html"),
  ])
    expect(callFailure("fix", err).message).toContain(
      "may or may not have run: check before trying again",
    );
  expect(callFailure("fix", new StreamableHTTPError(400, "Bad request")).message).toBe(
    "fix failed: Streamable HTTP error: Bad request",
  );
  expect(callFailure("fix", new McpError(ErrorCode.InternalError, "It broke")).message).toBe(
    "fix failed: MCP error -32603: It broke",
  );
});
