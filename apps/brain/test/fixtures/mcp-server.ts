// A small MCP server over stdio for the MCP plugin's tests.

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

// A server that isn't up yet: it won't start until this file exists.
if (process.env.MCP_WAIT_FOR && !existsSync(process.env.MCP_WAIT_FOR)) process.exit(1);

const server = new McpServer({ name: "fixture", version: "1.0.0" });
server.registerTool(
  "echo",
  { description: "Echo text back", inputSchema: { text: z.string() } },
  async ({ text }) => ({ content: [{ type: "text", text: `echo: ${text}` }] }),
);
server.registerTool(
  "secret",
  { description: "Show an environment variable", inputSchema: { name: z.string() } },
  async ({ name }) => ({
    content: [{ type: "text", text: `${name}=${process.env[name] ?? "(unset)"}` }],
  }),
);
server.registerTool("broken", { description: "Always fails" }, async () => ({
  isError: true,
  content: [{ type: "text", text: "disk on fire" }],
}));
// A write that's done, then the server dies before it answers.
const count = process.env.MCP_COUNT;
if (count)
  server.registerTool("once", { description: "Counts, then crashes" }, async () => {
    appendFileSync(count, "ran\n");
    process.exit(1);
  });
// The listing as given, whatever the tools really are: for definitions the API wouldn't take. From
// a file, as it is when the server starts: one that comes back with its tools changed.
const file = process.env.MCP_LIST_FILE;
const list = process.env.MCP_LIST ?? (file && readFileSync(file, "utf8"));
if (list)
  server.server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: JSON.parse(list),
  }));
// Slow to start while this file is there: calls made meanwhile find it reconnecting.
if (process.env.MCP_SLOW && existsSync(process.env.MCP_SLOW)) await Bun.sleep(1000);
await server.connect(new StdioServerTransport());
