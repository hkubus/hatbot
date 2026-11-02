// The stand-in Scout over stdio, for the MCP plugin: SCOUT_LOG, SCOUT_FULL=1, SCOUT_FLIPS and SCOUT_INBOX as
// scoutServer's options.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { scoutServer } from "./scout-tools";

const env = process.env;
await scoutServer({
  log: env.SCOUT_LOG,
  full: !!env.SCOUT_FULL,
  flips: env.SCOUT_FLIPS,
  inbox: env.SCOUT_INBOX,
}).connect(new StdioServerTransport());
