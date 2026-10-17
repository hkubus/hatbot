import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Task } from "@hatbot/shared";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { mayReview } from "../src/agent/review";
import { mcpPlugin, moneyKind, secretNames, toolName, unsent } from "../src/plugins/mcp";
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
  const { t } = await started({
    ...fixture,
    trusted: true,
    tools: { echo: "chat", secret: "off", broken: "allow" },
  });
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
  expect(status[0]?.tools.map((x) => x.mode)).toEqual(["always", "always", "ask", "ask"]);
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
