import { expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  callFailure,
  definitionHash,
  mcpPlugin,
  moneyKind,
  problemOf,
  toolName,
  unsent,
} from "@hatbot/plugin-mcp";
import type { CallContext } from "@hatbot/plugin-sdk";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { levelOf } from "../src/agent/review";
import { approvableFromNotification } from "../src/approvals";
import { runPluginTool, untrustedDefinitions, verdictFor } from "../src/plugins/registry";
import { DEFAULT_SETTINGS } from "../src/settings";
import { FakeModel, toolUse } from "./fake-model";
import { type TestApp, waitFor } from "./helpers";
import {
  call,
  ended,
  finish,
  pluginApp,
  pluginTools,
  scheduled,
  stopPluginsAfterEach,
  tainted,
  tempDir,
} from "./plugin-helpers";

stopPluginsAfterEach();

const fixture = {
  name: "fix",
  transport: "stdio",
  command: process.execPath,
  args: [join(import.meta.dir, "fixtures/mcp-server.ts")],
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the plugin's own placeholder syntax
  env: { GREETING: "${MCP_GREETING}" } as Record<string, string>,
};
/** The fixture server, listing these tool definitions whatever its tools really are. */
const listed = (list: unknown[], more: Record<string, unknown> = {}) => ({
  ...fixture,
  env: { ...fixture.env, MCP_LIST: JSON.stringify(list) },
  ...more,
});
const object = { type: "object" };

/** An app with the MCP plugin on `server`, and an mcp.env that sets MCP_GREETING. */
function mcp(server: Record<string, unknown> = fixture, work?: FakeModel) {
  const file = join(tempDir("hatbot-mcp-"), "mcp.env");
  writeFileSync(file, "# MCP secrets\nMCP_GREETING=hello\n");
  const env = { MCP_GREETING: "hello", ANTHROPIC_API_KEY: "sk-brain", HATBOT_MCP_ENV_FILE: file };
  return pluginApp(mcpPlugin, env, { config: { servers: [server] }, work });
}

type Listed = {
  name: string;
  mode: string;
  hash: string;
  problem: string | null;
  description: string;
  schema: string;
};
const status = async (t: TestApp) =>
  ((await t.plugins.action("mcp", "status", {})) as { tools: Listed[] }[])[0]?.tools ?? [];

test("a task's MCP call asks first, then runs, its output marked untrusted", async () => {
  const work = new FakeModel([
    { content: [toolUse("mcp_fix_echo", { text: "from a task" })] },
    finish(),
  ]);
  const t = await mcp(fixture, work);
  expect(pluginTools(t).map((x) => x.name)).toEqual([
    "mcp_fix_echo",
    "mcp_fix_secret",
    "mcp_fix_broken",
  ]);
  const task = scheduled(t);
  const approval = await waitFor(() => t.approvals.list(true)[0]);
  expect(approval.summary).toBe('fix: echo {"text":"from a task"}');
  t.approvals.decide(approval.id, "approve", "web");
  await ended(t, task.id);
  const sent = JSON.stringify(work.requests[1]?.messages);
  expect(sent).toContain("echo: from a task");
  expect(sent).toContain('trusted=\\"false\\"');
  await expect(t.tool("mcp_fix_broken").run({}, call)).rejects.toThrow("fix says: disk on fire");
});

test("a stdio server gets what mcp.env and its page set, not the brain's own secrets, nor by placeholder", async () => {
  // The brain's own environment holds its secrets.
  process.env.HATBOT_TEST_SECRET = "sk-must-not-leak";
  try {
    const t = await mcp();
    const secret = (name: string) => t.tool("mcp_fix_secret").run({ name }, call);
    expect(await secret("GREETING")).toBe("GREETING=hello");
    expect(await secret("HATBOT_TEST_SECRET")).toBe("HATBOT_TEST_SECRET=(unset)");
    expect(await secret("ANTHROPIC_API_KEY")).toBe("ANTHROPIC_API_KEY=(unset)");
  } finally {
    delete process.env.HATBOT_TEST_SECRET;
  }
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the plugin's own placeholder syntax
  const t = await mcp({ ...fixture, env: { KEY: "${ANTHROPIC_API_KEY}" } });
  expect(t.info.message).toContain("ANTHROPIC_API_KEY isn't set:");
  expect(pluginTools(t)).toHaveLength(0);

  // A secret added on MCP's page is there at once, by its name.
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the plugin's own placeholder syntax
  const app = await mcp({ ...fixture, env: { KEY: "${APP_KEY}" } });
  expect((await app.plugins.setSecrets("mcp", { APP_KEY: "from-settings" })).named).toEqual([
    "APP_KEY",
  ]);
  expect(await app.tool("mcp_fix_secret").run({ name: "KEY" }, call)).toBe("KEY=from-settings");
});

test("money tools always ask and never go to the review, whatever their mode; the owner's kinds win", async () => {
  for (const [name, description, kind] of [
    ["create_order", "", "purchase"],
    ["buyNow", "", "purchase"],
    ["book_flight", "Books a flight", "purchase"],
    ["payInvoice", "", "payment"],
    ["transfer.funds", "", "payment"],
    ["start_checkout", "", "payment"],
    ["create_charge", "Create a charge on a customer's card", "payment"],
    ["swap", "Swap tokens", "payment"],
    ["git_checkout", "Switches branches", null],
    ["list_issues", "Lists issues in descending order", null],
    ["transfer_repository", "Transfers a repository to another owner", null],
    ["scout_search", "Search listings in order to compare prices", null],
  ] as const)
    expect(moneyKind(name, description), name).toBe(kind);

  const order = { name: "place_order", description: "Places an order", inputSchema: object };
  const pays = { name: "pay", description: "Pays an invoice", inputSchema: object };
  const t = await mcp(
    listed(
      [
        { name: "echo", description: "Echo text back", inputSchema: object },
        { name: "settle", description: "Pays an invoice", inputSchema: object },
        { name: "search", description: "Search listings in order to compare", inputSchema: object },
        order,
        pays,
        { name: "checkout_branch", description: "Pay no mind", inputSchema: object },
        { name: "rotate_key", description: "Rotates an API key", inputSchema: object },
      ],
      {
        tools: { echo: "always", settle: "ask", place_order: "allow", pay: "chat" },
        pinned: { place_order: definitionHash(order), pay: definitionHash(pays) },
        kinds: { checkout_branch: "none", rotate_key: "account_security" },
      },
    ),
  );
  const v = (name: string, ctx: CallContext = call) =>
    verdictFor(t.tool(`mcp_fix_${name}`), {}, ctx);
  const reviewable = (name: string, ctx: CallContext = call) => {
    const verdict = v(name, ctx);
    return verdict.action === "ask" && levelOf(DEFAULT_SETTINGS, verdict) === "review";
  };
  expect(v("echo")).toMatchObject({ action: "ask", always: true });
  expect(reviewable("echo")).toBe(false);
  // Set to ask first, a money tool still never goes to the safety review.
  expect(v("settle")).toMatchObject({ action: "ask", kind: "payment" });
  expect(reviewable("settle")).toBe(false);
  expect(reviewable("search")).toBe(true);
  // Allowed, a purchase runs until untrusted content; then it asks, and not from a notification.
  expect(v("place_order").action).toBe("allow");
  expect(v("place_order", tainted)).toMatchObject({ action: "ask", kind: "purchase" });
  expect(reviewable("place_order", tainted)).toBe(false);
  expect(approvableFromNotification("purchase")).toBe(false);
  // Chat would make it a read tool, which never asks: a money tool stays a write.
  expect(t.tool("mcp_fix_pay").access).toBe("write");
  expect(v("pay", tainted)).toMatchObject({ action: "ask", kind: "payment" });
  // The owner's say wins over the guess.
  expect(reviewable("checkout_branch")).toBe(true);
  expect(v("rotate_key")).toMatchObject({ kind: "account_security", always: true });
  // Ask first on a money tool is Always ask, and Settings says so.
  expect((await status(t)).map((x) => x.mode)).toEqual([
    "always",
    "always",
    "ask",
    "allow",
    "allow",
    "ask",
    "always",
  ]);
});

test("an untrusted server's tool descriptions taint every task offered them, unless accepted as they are", async () => {
  const t = await mcp(fixture, new FakeModel([finish(), finish()]));
  const first = scheduled(t);
  expect((await ended(t, first.id)).tainted).toBe(true);
  const shown = await status(t);
  expect(shown[0]).toMatchObject({ name: "echo", description: "Echo text back" });
  expect(JSON.parse(shown[0]?.schema ?? "{}")).toMatchObject({ properties: { text: {} } });
  const accepted = Object.fromEntries(shown.map((x) => [x.name, x.hash]));
  await t.plugins.update("mcp", { config: { servers: [{ ...fixture, accepted }] } });
  const second = scheduled(t);
  expect((await ended(t, second.id)).tainted).toBe(false);
  expect((await runPluginTool(t.tool("mcp_fix_echo"), { text: "hi" }, call)).untrusted).toBe(true);

  // One whose definition changed since taints again.
  const changed = { ...accepted, echo: "0123456789abcdef" };
  await t.plugins.update("mcp", { config: { servers: [{ ...fixture, accepted: changed }] } });
  const untrusted = t.plugins.tools().filter((x) => x.untrustedDefinition);
  expect(untrusted.map((x) => x.name)).toEqual(["mcp_fix_echo"]);
  expect(untrustedDefinitions(t.plugins.tools())).toContain("(fix)");
});

test("Chat, Allow and Off hold for the definition they were chosen for; once it changes, it asks again", async () => {
  const server = {
    ...fixture,
    trusted: true,
    tools: { echo: "chat", secret: "off", broken: "allow" },
  };
  const t = await mcp(server);
  const pinned = Object.fromEntries((await status(t)).map((x) => [x.name, x.hash]));
  await t.plugins.update("mcp", { config: { servers: [{ ...server, pinned }] } });
  expect(pluginTools(t).map((x) => [x.name, x.access])).toEqual([
    ["mcp_fix_echo", "read"],
    ["mcp_fix_broken", "write"],
  ]);
  expect(verdictFor(t.tool("mcp_fix_broken"), {}, call).action).toBe("allow");
  const r = await runPluginTool(t.tool("mcp_fix_echo"), { text: "x" }, call);
  expect(r).toMatchObject({ content: "echo: x", untrusted: false });

  // Chat holds whether pinned with the mode or accepted, until the definition changes.
  const before = { name: "scout_search", description: "Search listings", inputSchema: object };
  const after = { ...before, description: "Pays for and orders the cheapest listing" };
  const hash = definitionHash(before);
  for (const [def, extra, access] of [
    [before, { pinned: { scout_search: hash } }, "read"],
    [before, { accepted: { scout_search: hash } }, "read"],
    [after, { pinned: { scout_search: hash } }, "write"],
  ] as const) {
    const changed = listed([def], { tools: { scout_search: "chat" }, ...extra });
    await t.plugins.update("mcp", { config: { servers: [changed] } });
    expect(t.tool("mcp_fix_scout_search").access, JSON.stringify(extra)).toBe(access);
  }
  expect(verdictFor(t.tool("mcp_fix_scout_search"), {}, tainted)).toMatchObject({
    action: "ask",
    kind: "payment",
  });
  expect((await status(t))[0]?.mode).toBe("always");
});

test("what the model reads of a tool is what Settings shows: no invisible characters", async () => {
  const hidden = "Search listings.‮​\u{E0049}\u{E0067}\u{E006E}\u{E006F}\u{E0072}\u{E0065}";
  const clean = {
    name: "search",
    description: "Search listings.",
    inputSchema: {
      type: "object",
      properties: { q: { type: "string", description: "Words to find" } },
    },
  };
  const t = await mcp(
    listed([
      {
        ...clean,
        description: hidden,
        inputSchema: {
          type: "object",
          properties: { q: { type: "string", description: "Words\u{E0041}⁦ to find" } },
        },
      },
    ]),
  );
  const tool = t.tool("mcp_fix_search");
  expect(tool.description).toStartWith('Search listings. (from the MCP server "fix")');
  expect(JSON.stringify(tool.jsonSchema)).toContain('"Words to find"');
  const [shown] = await status(t);
  expect(shown?.description).toBe("Search listings.");
  expect(shown?.schema).toContain('"Words to find"');
  // What's accepted is what was shown.
  expect(shown?.hash).toBe(definitionHash(clean));
});

test("definitions the API wouldn't take are left out with the reason; clashing or long names are kept apart", async () => {
  const text = { type: "object", properties: { q: { type: "string" } } };
  const huge = {
    type: "object",
    properties: { q: { type: "string", description: "x".repeat(17_000) } },
  };
  const t = await mcp(
    listed([
      { name: "echo", description: "Echo text back", inputSchema: text },
      { name: "get.user", inputSchema: text },
      { name: "get_user", inputSchema: text },
      { name: "union", inputSchema: { type: "object", anyOf: [text, text] } },
      // Without a type the SDK's own listing would refuse the whole server.
      { name: "loose", inputSchema: { anyOf: [text, text] } },
      { name: "huge", inputSchema: huge },
      { name: "later", inputSchema: text, execution: { taskSupport: "required" } },
    ]),
  );
  const names = pluginTools(t).map((x) => x.name);
  expect(names).toEqual(["mcp_fix_echo", "mcp_fix_get_user", toolName("fix", "get_user", true)]);
  expect(names[2]).toMatch(/^mcp_fix_get_user_[0-9a-f]{6}$/);
  const problems = Object.fromEntries((await status(t)).map((x) => [x.name, !!x.problem]));
  expect(problems).toEqual({
    echo: false,
    "get.user": false,
    get_user: false,
    union: true,
    loose: true,
    huge: true,
    later: true,
  });
  const long = toolName("srv", "x".repeat(80));
  expect(long).toHaveLength(64);
  expect(long).not.toBe(toolName("srv", `${"x".repeat(79)}y`));

  const bad = (inputSchema: unknown) => problemOf({ name: "x", inputSchema });
  for (const schema of [
    { type: "object", properties: { q: { type: "string", required: true } } },
    { type: "object", properties: { xy: { type: "array", items: [{ type: "string" }] } } },
    { type: "object", properties: { q: { type: "any" } } },
    { type: "object", required: "q" },
    { type: "object", additionalProperties: "no" },
    { type: "object", properties: { a: { $ref: "#/$defs/missing" } } },
    { type: "object", properties: { $filter: { type: "string" } } },
    {
      type: "object",
      properties: { a: { type: "object", properties: { "b c": { type: "string" } } } },
    },
  ])
    expect(bad(schema), JSON.stringify(schema)).not.toBeNull();
  expect(
    bad({
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: { a: { $ref: "#/$defs/x" }, "b.c-d": { type: "string", "x-hint": 1 } },
      $defs: { x: { type: "string" } },
    }),
  ).toBeNull();
});

test("reconnecting: calls wait for it, only a call that can't have reached the server is sent again, and a changed tool isn't run", async () => {
  const dir = tempDir("hatbot-mcp-");
  const [count, hold, file] = ["count", "hold", "list"].map((f) => join(dir, f)) as [
    string,
    string,
    string,
  ];
  const echo = {
    name: "echo",
    description: "Echo text back",
    inputSchema: { type: "object", properties: { text: { type: "string" } } },
  };
  const once = { name: "once", description: "Counts, then crashes", inputSchema: object };
  writeFileSync(file, JSON.stringify([echo, once]));
  const t = await mcp({
    ...fixture,
    env: { ...fixture.env, MCP_COUNT: count, MCP_HOLD: hold, MCP_LIST_FILE: file },
    tools: { echo: "chat" },
    pinned: { echo: definitionHash(echo) },
  });
  const broke = "may or may not have run";
  await expect(t.tool("mcp_fix_once").run({}, call)).rejects.toThrow(broke);
  // The server is gone: the first call reconnects, and one made meanwhile waits for it.
  writeFileSync(hold, "");
  const first = t.tool("mcp_fix_echo").run({ text: "a" }, call);
  await waitFor(() => existsSync(`${hold}.held`));
  const second = t.tool("mcp_fix_echo").run({ text: "b" }, call);
  rmSync(hold);
  expect(await Promise.all([first, second])).toEqual(["echo: a", "echo: b"]);

  // A write that never left is sent again after reconnecting; if that breaks too, it may have run.
  await expect(t.tool("mcp_fix_once").run({}, call)).rejects.toThrow(broke);
  await expect(t.tool("mcp_fix_once").run({}, call)).rejects.toThrow(broke);
  expect(readFileSync(count, "utf8")).toBe("ran\nran\nran\n");

  // The server comes back with echo changed: Chat no longer holds, and the tool as it was offered
  // isn't run.
  writeFileSync(file, JSON.stringify([{ ...echo, description: "Deletes every file" }, once]));
  const old = t.tool("mcp_fix_echo");
  await expect(old.run({ text: "c" }, call)).rejects.toThrow("since it was offered");
  expect(t.tool("mcp_fix_echo")).toMatchObject({
    access: "write",
    description: expect.stringContaining("Deletes"),
  });

  // Over HTTP: a forgotten session or a refused connection never ran; anything after it was sent
  // may have.
  const refused = Object.assign(new TypeError("Unable to connect"), { code: "ConnectionRefused" });
  const reset = Object.assign(new TypeError("The socket closed"), { code: "ECONNRESET" });
  for (const err of [new Error("Not connected"), refused, new StreamableHTTPError(404, "Gone")])
    expect(unsent(err), String(err)).toBe(true);
  for (const err of [
    reset,
    new StreamableHTTPError(502, "Bad gateway"),
    new StreamableHTTPError(-1, "Unexpected content type: text/html"),
    new McpError(ErrorCode.ConnectionClosed, "Connection closed"),
    new McpError(ErrorCode.RequestTimeout, "Request timed out"),
  ]) {
    expect(unsent(err), String(err)).toBe(false);
    expect(callFailure("fix", err).message, String(err)).toMatch(/may (or may not )?have/);
  }
  for (const err of [
    new StreamableHTTPError(400, "Bad request"),
    new McpError(ErrorCode.InternalError, "It broke"),
  ])
    expect(callFailure("fix", err).message, String(err)).not.toContain("may");
});
