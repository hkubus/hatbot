// A small MCP server over stdio for the MCP plugin's tests.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

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
await server.connect(new StdioServerTransport());
