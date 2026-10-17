// MCP (PLAN.md §4.5, §5.5): tools from Model Context Protocol servers, over streamable HTTP or as a
// local process (stdio). Each tool is "ask first" until you allow it in Settings, and one that looks
// like it pays or buys always asks; output is untrusted unless you trust the server. A stdio server
// runs on the brain as the hatbot user, so prefer HTTP servers that run elsewhere for anything you
// didn't write.
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema, ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  allow,
  ask,
  askAlways,
  definePlugin,
  PluginError,
  type PluginInstance,
  type PluginTool,
  tool,
} from "../plugin";

const CONNECT_TIMEOUT_MS = 20_000;
const CALL_TIMEOUT_MS = 120_000;

/**
 * chat: the chat may call it directly, without asking (you vouch that it only reads). allow: tasks run
 * it. ask: tasks ask first, and the safety review may answer for you. always: tasks always ask you.
 * off: not offered.
 */
const Mode = z.enum(["chat", "allow", "ask", "always", "off"]);
type Mode = z.infer<typeof Mode>;

const PAYS =
  /\b(pay|pays|paid|paying|payments?|payouts?|checkout|check out|transfers?|transferring|refunds?|withdraw|withdrawals?)\b/i;
const BUYS =
  /\b(buy|buys|buying|purchase|purchases|purchasing|orders?|ordering|bid|bids|bidding)\b/i;

/** Whether a tool looks like it moves money, from its name and description: what it'd be approving. */
export function moneyKind(name: string, description = ""): "payment" | "purchase" | null {
  const words = name.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_.-]+/g, " ");
  const text = `${words} ${description}`.replace(
    /\b(in order (to|that|for)|sort(ing)? order)\b/gi,
    "",
  );
  if (PAYS.test(text)) return "payment";
  if (BUYS.test(text)) return "purchase";
  return null;
}

const Server = z.object({
  name: z.string().regex(/^[a-z][a-z0-9]{0,15}$/, "Lowercase letters and digits, e.g. github"),
  transport: z.enum(["http", "stdio"]).default("http"),
  url: z.string().url().optional(),
  /** Request headers; values may use ${NAME} for secrets in /etc/hatbot/mcp.env. */
  headers: z.record(z.string(), z.string()).default({}),
  command: z.string().min(1).optional(),
  args: z.array(z.string()).default([]),
  /** Extra environment for a stdio server; values may use ${NAME}. */
  env: z.record(z.string(), z.string()).default({}),
  /** Its output counts as trusted content (PLAN.md §6.1). */
  trusted: z.boolean().default(false),
  enabled: z.boolean().default(true),
  /** Per tool; tools not listed are "ask", or "always" when they look like they pay or buy. */
  tools: z.record(z.string(), Mode).default({}),
});
type Server = z.infer<typeof Server>;

const Config = z.object({
  servers: z
    .array(Server)
    .default([])
    .refine((s) => new Set(s.map((x) => x.name)).size === s.length, "Server names must differ")
    .refine(
      (s) => s.every((x) => (x.transport === "http" ? x.url : x.command)),
      "An HTTP server needs a URL; a stdio server needs a command",
    ),
});

type Listed = { name: string; description?: string; inputSchema: Record<string, unknown> };
type Conn = {
  server: Server;
  client: Client | null;
  tools: Listed[];
  error: string | null;
};

/** ${NAME} from the brain's environment, or an error naming what's missing. */
function expand(values: Record<string, string>, env: Record<string, string | undefined>) {
  const missing: string[] = [];
  const out = Object.fromEntries(
    Object.entries(values).map(([k, v]) => [
      k,
      v.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name: string) => {
        const value = env[name];
        if (value === undefined) missing.push(name);
        return value ?? "";
      }),
    ]),
  );
  if (missing.length)
    throw new PluginError(
      `${missing.join(", ")} isn't set in the brain's environment (/etc/hatbot/mcp.env).`,
    );
  return out;
}

/** A tool name the API accepts: mcp_<server>_<tool>, at most 64 characters. */
export function toolName(server: string, name: string): string {
  const full = `mcp_${server}_${name.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
  if (full.length <= 64) return full;
  const hash = createHash("sha256").update(name).digest("hex").slice(0, 6);
  return `${full.slice(0, 57)}_${hash}`;
}

/** The schema as the API wants it: no $schema or $id. */
function withoutMeta(schema: Record<string, unknown>): Record<string, unknown> {
  const { $schema: _, $id: __, ...rest } = schema;
  return rest;
}

/** What fetch says when it couldn't open a connection at all. */
const NO_CONNECTION = new Set(["ConnectionRefused", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]);

/**
 * Whether a failed call can't have reached the server, so sending it again can't run it twice: the
 * connection was already gone, the server couldn't be reached, or it had forgotten the session (it
 * refuses those calls before running anything).
 */
export function unsent(err: unknown): boolean {
  if (err instanceof StreamableHTTPError) return err.code === 404;
  if (err instanceof McpError || !(err instanceof Error)) return false;
  if (err.message === "Not connected") return true;
  const code =
    (err as { code?: unknown }).code ?? (err.cause as { code?: unknown } | undefined)?.code;
  return typeof code === "string" && NO_CONNECTION.has(code);
}

/** An MCP tool result as text for the model. */
function resultText(r: { content?: unknown; structuredContent?: unknown }): string {
  const parts: string[] = [];
  for (const c of (r.content ?? []) as Record<string, unknown>[]) {
    if (c.type === "text") parts.push(String(c.text));
    else if (c.type === "resource") {
      const res = c.resource as { uri?: string; text?: string };
      parts.push(res.text ?? `[resource ${res.uri}]`);
    } else if (c.type === "resource_link") parts.push(`[link ${c.uri}]`);
    else parts.push(`[${c.type} omitted]`);
  }
  if (!parts.length && r.structuredContent !== undefined)
    parts.push(JSON.stringify(r.structuredContent, null, 2));
  return parts.join("\n") || "(no output)";
}

export const mcpPlugin = definePlugin({
  id: "mcp",
  name: "MCP",
  description: "Tools from Model Context Protocol servers",
  config: Config,
  start: async ({ env, config }) => {
    const conns: Conn[] = config.servers
      .filter((s) => s.enabled)
      .map((server) => ({ server, client: null, tools: [], error: null }));
    /** Set by stop: a call still in flight mustn't reconnect and leave a process behind. */
    let stopped = false;
    const reconnecting = new Map<Conn, Promise<void>>();

    /** Reconnects once for every call that failed at the same time. */
    const reconnect = (c: Conn) => {
      const pending = reconnecting.get(c);
      if (pending) return pending;
      const p = connect(c).finally(() => reconnecting.delete(c));
      reconnecting.set(c, p);
      return p;
    };

    const connect = async (c: Conn) => {
      if (stopped) throw new PluginError("MCP restarted; try again.");
      await c.client?.close().catch(() => {});
      c.client = null;
      c.error = null;
      const client = new Client({ name: "hatbot", version: "1.0.0" });
      try {
        const s = c.server;
        const transport =
          s.transport === "http"
            ? new StreamableHTTPClientTransport(new URL(s.url as string), {
                requestInit: { headers: expand(s.headers, env) },
              })
            : new StdioClientTransport({
                command: s.command as string,
                args: s.args,
                env: expand(s.env, env),
                stderr: "inherit",
              });
        await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
        const listed = await client.listTools(undefined, { timeout: CONNECT_TIMEOUT_MS });
        if (stopped) {
          await client.close().catch(() => {});
          return;
        }
        c.tools = listed.tools as Listed[];
        c.client = client;
      } catch (err) {
        await client.close().catch(() => {});
        c.error = err instanceof Error ? err.message.slice(0, 300) : "couldn't connect";
        c.tools = [];
      }
    };
    await Promise.all(conns.map(connect));

    const modeOf = (c: Conn, t: Listed): Mode =>
      c.server.tools[t.name] ?? (moneyKind(t.name, t.description) ? "always" : "ask");
    const toolsOf = (c: Conn): PluginTool[] =>
      c.tools
        .map((t) => ({ t, mode: modeOf(c, t), kind: moneyKind(t.name, t.description) }))
        .filter(({ mode }) => mode !== "off")
        .map(({ t, mode, kind }) =>
          tool({
            name: toolName(c.server.name, t.name),
            description: `${(t.description ?? t.name).slice(0, 1000)} (from the MCP server "${c.server.name}")`,
            access: mode === "chat" ? "read" : "write",
            untrusted: !c.server.trusted,
            untrustedDefinition: !c.server.trusted,
            label: `Using ${c.server.name}`,
            schema: z.record(z.string(), z.unknown()),
            jsonSchema: { type: "object", properties: {}, ...withoutMeta(t.inputSchema) },
            describe: (input) => `${c.server.name}: ${t.name} ${JSON.stringify(input)}`,
            ...(mode === "chat"
              ? {}
              : {
                  // Money is never left to the safety review: its kind keeps the review out.
                  policy: () =>
                    mode === "allow"
                      ? allow()
                      : kind
                        ? askAlways(
                            `It may ${kind === "payment" ? "pay or move money" : "buy or order something"}, so it always asks.`,
                            kind,
                          )
                        : mode === "always"
                          ? askAlways("The owner asked to always be asked before this tool runs.")
                          : ask(`MCP tools ask first unless the owner allows them in Settings.`),
                }),
            run: async (input, { signal }) => {
              // Through request, not callTool: callTool also checks the result against the tool's
              // output schema, and fails after the server has done the work.
              const call = async () => {
                if (!c.client)
                  throw new PluginError(`${c.server.name} isn't connected: ${c.error}`);
                return c.client.request(
                  { method: "tools/call", params: { name: t.name, arguments: input } },
                  CallToolResultSchema,
                  { signal, timeout: CALL_TIMEOUT_MS },
                );
              };
              const failed = (err: unknown) =>
                new PluginError(
                  `${c.server.name} failed: ${err instanceof Error ? err.message.slice(0, 300) : "error"}`,
                );
              let r: Awaited<ReturnType<typeof call>>;
              try {
                r = await call();
              } catch (err) {
                if (signal.aborted || err instanceof PluginError) throw err;
                const answered =
                  (err instanceof McpError && err.code !== ErrorCode.ConnectionClosed) ||
                  err instanceof StreamableHTTPError;
                // A call that may have reached the server is sent again only if it only reads (the
                // owner said so): a write could run twice.
                if (!unsent(err) && (mode !== "chat" || answered)) {
                  if (err instanceof McpError && err.code === ErrorCode.RequestTimeout)
                    throw new PluginError(
                      `${c.server.name} didn't answer in ${CALL_TIMEOUT_MS / 1000} s. It may have done it anyway: check before trying again.`,
                    );
                  if (!answered)
                    throw new PluginError(
                      `The connection to ${c.server.name} broke during the call, so it may or may not have run: check before trying again.`,
                    );
                  throw failed(err);
                }
                // The server restarted, dropped the session or the connection: reconnect once.
                await reconnect(c);
                try {
                  r = await call();
                } catch (again) {
                  if (signal.aborted) throw again;
                  throw again instanceof PluginError ? again : failed(again);
                }
              }
              const text = resultText(r as { content?: unknown; structuredContent?: unknown });
              if (r.isError) throw new PluginError(`${c.server.name} says: ${text.slice(0, 2000)}`);
              return text;
            },
          }),
        );

    let tools = conns.flatMap(toolsOf);
    const guidance = () =>
      tools.length
        ? `MCP servers: ${conns
            .filter((c) => c.client)
            .map(
              (c) =>
                `${c.server.name} (${c.server.trusted ? "trusted" : "its output is untrusted"})`,
            )
            .join(", ")}. Their tools are named mcp_<server>_<tool>.`
        : undefined;
    let guide = guidance();
    const failed = () => conns.filter((c) => !c.client);
    const status = () =>
      config.servers.map((s) => {
        const c = conns.find((x) => x.server.name === s.name);
        return {
          name: s.name,
          state: !s.enabled ? "off" : c?.client ? "connected" : "failed",
          error: c?.error ?? null,
          tools: (c?.tools ?? []).map((t) => ({
            name: t.name,
            description: (t.description ?? "").slice(0, 300),
            mode: c ? modeOf(c, t) : "ask",
          })),
        };
      });

    const instance: PluginInstance = {
      status: !config.servers.length
        ? { state: "needs_setup", message: "Add an MCP server." }
        : conns.length && conns.every((c) => !c.client)
          ? {
              state: "error",
              message: conns.map((c) => `${c.server.name}: ${c.error}`).join("\n"),
            }
          : { state: "ready" },
      // Getters: a server that comes back later brings its tools.
      get tools() {
        return tools;
      },
      get guidance() {
        return guide;
      },
      test: async () =>
        status()
          .map((s) =>
            s.state === "connected"
              ? `${s.name}: connected, ${s.tools.length} tools`
              : `${s.name}: ${s.state}${s.error ? ` (${s.error})` : ""}`,
          )
          .join("\n") || "No servers.",
      actions: { status: async () => status() },
      // Servers that were down at the start, or dropped and couldn't be reconnected.
      down: () => {
        const down = failed();
        return down.length ? down.map((c) => `${c.server.name}: ${c.error}`).join("\n") : null;
      },
      recover: async () => {
        const down = failed();
        if (!down.length) return;
        await Promise.all(down.map(reconnect));
        if (down.some((c) => c.client)) {
          tools = conns.flatMap(toolsOf);
          guide = guidance();
          console.log(
            `mcp: ${down
              .filter((c) => c.client)
              .map((c) => c.server.name)
              .join(", ")} back`,
          );
        }
      },
      stop: async () => {
        stopped = true;
        await Promise.all(reconnecting.values()).catch(() => {});
        await Promise.all(conns.map((c) => c.client?.close().catch(() => {})));
      },
    };
    return instance;
  },
});
