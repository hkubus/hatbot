import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Task } from "@hatbot/shared";
import { z } from "zod";
import { mcpPlugin, toolName } from "../src/plugins/mcp";
import { type CallContext, definePlugin, PluginError, ready } from "../src/plugins/plugin";
import { runPluginTool, verdictFor } from "../src/plugins/registry";
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

async function started(server: Record<string, unknown> = fixture, model = new FakeModel()) {
  // The brain's own environment holds its secrets; a stdio server must not inherit them.
  process.env.HATBOT_TEST_SECRET = "sk-must-not-leak";
  const t = await testApp(new FakeModel(), model, {}, [mcpPlugin], { MCP_GREETING: "hello" });
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

test("a server that won't start is reported, and a missing secret says which", async () => {
  const { info, t } = await started({ ...fixture, command: "/nonexistent/server" });
  expect(info.state).toBe("error");
  expect(info.message).toContain("fix:");
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the plugin's own placeholder syntax
  const r = await started({ ...fixture, env: { X: "${MCP_NOPE}" } });
  expect(r.info.message).toContain("MCP_NOPE isn't set");
  await t.plugins.stopAll();
  await r.t.plugins.stopAll();
});

test("a server that was down at the start comes back later, with its tools", async () => {
  const marker = join(mkdtempSync(join(tmpdir(), "hatbot-mcp-")), "up");
  const t = await testApp(new FakeModel(), new FakeModel(), {}, [mcpPlugin], {
    MCP_GREETING: "hi",
  });
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
