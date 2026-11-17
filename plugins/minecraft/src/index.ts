import {
  ask,
  covered,
  definePlugin,
  needsSetup,
  PluginError,
  ready,
  type SecretsHost,
  tool,
} from "@hatbot/plugin-sdk";
import { SecretName, SecretValue, secretPlaceholder } from "@hatbot/shared";
import { z } from "zod";
import { MAX_COMMAND_BYTES, ping, plain, REFUSED, rcon, type Status } from "./protocol";

const Server = z.object({
  name: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,30}$/, "Lowercase letters, digits and -, e.g. survival"),
  host: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.:-]{0,252}$/, "A hostname or IP address"),
  port: z.number().int().min(1).max(65535).default(25565),
  rconPort: z.number().int().min(1).max(65535).default(25575),
  /** The owner's secret that holds RCON's password; without one, commands are off. */
  rconSecret: z.union([SecretName, z.literal("")]).default(""),
});
type Server = z.infer<typeof Server>;

const Config = z.object({
  servers: z
    .array(Server)
    .refine((s) => new Set(s.map((x) => x.name)).size === s.length, "Two servers have one name.")
    .default([]),
});

/** Queries with nothing after them, or one of their few fixed forms. */
const LOOKS_EXACTLY = new Set([
  "list",
  "list uuids",
  "banlist",
  "banlist players",
  "banlist ips",
  "whitelist list",
  "seed",
  "difficulty",
  "time query daytime",
  "time query gametime",
  "time query day",
  "worldborder get",
  "scoreboard objectives list",
  "bossbar list",
  "datapack list",
  "datapack list available",
  "datapack list enabled",
  "tick query",
]);
/**
 * Queries that take free arguments, by their first words. Brigadier runs a line only once it has
 * read all of it as one command, so what follows can only be that query's own arguments.
 */
const LOOKS_FROM = [
  "help",
  "data get",
  "scoreboard players list",
  "scoreboard players get",
  "team list",
  "bossbar get",
  "forceload query",
  "experience query",
  "xp query",
  "forge tps",
  "neoforge tps",
];
/** A game rule with no value says what it is. */
const RULE_QUERY = /^gamerule [^ ]+$/;

const looksOnly = (command: string) =>
  LOOKS_EXACTLY.has(command) ||
  RULE_QUERY.test(command) ||
  LOOKS_FROM.some((p) => command === p || command.startsWith(`${p} `));

const SENDS = new Set(["say", "tell", "msg", "w", "me", "teammsg", "tm", "tellraw", "title"]);
const WHY: Record<string, string> = {
  op: "It changes who can run server commands.",
  deop: "It changes who can run server commands.",
  whitelist: "It changes who can join the server.",
  ban: "It changes who can join the server.",
  "ban-ip": "It changes who can join the server.",
  pardon: "It changes who can join the server.",
  "pardon-ip": "It changes who can join the server.",
  kick: "It throws a player off the server.",
  stop: "It stops the server, and nothing here starts it again.",
};
const head = (command: string) => command.split(" ")[0] ?? "";
const whyOf = (command: string) =>
  WHY[head(command)] ??
  (SENDS.has(head(command))
    ? "It sends a message to the players."
    : "It may change the server or its world.");

const LOOKS = "It only looks; it changes nothing.";

const Command = z
  .string()
  .regex(/^[^\p{Cc}]*$/u, "One line, without control characters.")
  // Minecraft takes a leading slash too; the policy reads the words without it.
  .transform((s) => s.trim().replace(/^\//, "").replace(/ +/g, " "))
  .refine((s) => s.length > 0, "Give a command.")
  .refine(
    (s) => Buffer.byteLength(s) <= MAX_COMMAND_BYTES,
    `At most ${MAX_COMMAND_BYTES} bytes: RCON takes no more.`,
  )
  .describe("A server command as the console takes it, without the slash: whitelist add Steve");

/** The names after "players online:" in vanilla's answer to list. */
const playersIn = (answer: string) => {
  const m = /players online:(.*)$/s.exec(plain(answer));
  return m
    ? (m[1] ?? "")
        .split(",")
        .map((n) => n.trim())
        .filter(Boolean)
    : null;
};

/** Players who hide from server lists are named so in the sample. */
const ANONYMOUS = "Anonymous Player";

export const minecraftPlugin = definePlugin({
  id: "minecraft",
  name: "Minecraft",
  description: "Who's on your Minecraft servers, and server commands over RCON",
  needs: ["secrets"],
  config: Config,
  start: ({ config, service }) => {
    const secrets = service<SecretsHost>("secrets");
    const actions = {
      /** The names of the owner's secrets, never their values. */
      kept: async () => secrets.names(),
      keep: async (args: unknown) => {
        const r = z.object({ name: SecretName, value: SecretValue }).safeParse(args);
        if (!r.success) throw new PluginError(r.error.issues[0]?.message ?? "That isn't right.");
        secrets.keep(r.data.name, r.data.value);
        return null;
      },
    };
    if (!config.servers.length)
      return {
        ...needsSetup(
          "Add your servers below: where each one is, and RCON's password to run commands.",
        ),
        actions,
      };

    const names = config.servers.map((s) => s.name);
    const byName = new Map(config.servers.map((s) => [s.name, s]));
    const serverField = z
      .string()
      .optional()
      .describe(
        names.length > 1 ? `One of: ${names.join(", ")}` : `${names[0]}, the only one; optional`,
      );
    const nameOf = (server?: string) =>
      server?.trim().toLowerCase() ?? (names.length === 1 ? (names[0] as string) : "Minecraft");
    const pick = (server?: string): Server => {
      if (server === undefined) {
        if (config.servers.length === 1) return config.servers[0] as Server;
        throw new PluginError(`Say which server: ${names.join(", ")}.`);
      }
      const s = byName.get(server.trim().toLowerCase());
      if (!s) throw new PluginError(`No server named "${server}". They are: ${names.join(", ")}.`);
      return s;
    };

    /** Even one too short for the brain's own hiding never shows. */
    const hidden = (text: string, password: string) =>
      password ? text.split(password).join("[hidden]") : text;

    const command = async (s: Server, line: string, signal?: AbortSignal) => {
      if (!s.rconSecret)
        throw new PluginError(
          `${s.name} has no RCON password, so it can't run commands: the owner sets it in Settings → Minecraft.`,
        );
      // Read at every call, so a password changed in Settings → Secrets works at once.
      const password = secrets.fill(secretPlaceholder(s.rconSecret));
      try {
        return hidden(
          plain(await rcon({ host: s.host, port: s.rconPort }, password, line, { signal })),
          password,
        ).trim();
      } catch (err) {
        if (!(err instanceof PluginError)) throw err;
        if (err.status === REFUSED)
          throw new PluginError(
            `${s.name} refused the RCON password: ${s.rconSecret} doesn't match rcon.password in its server.properties.`,
          );
        throw new PluginError(hidden(`${s.name}'s RCON: ${err.message}`, password));
      }
    };

    const statusOf = async (s: Server, signal?: AbortSignal) => {
      const where = `${s.name} (${s.host}:${s.port})`;
      let st: Status;
      try {
        st = await ping({ host: s.host, port: s.port }, { signal });
      } catch (err) {
        if (!(err instanceof PluginError)) throw err;
        return `${where}: down. ${err.message}`;
      }
      let players = st.sample;
      let note = "";
      const cut = st.online > players.length || players.includes(ANONYMOUS);
      if (st.online > 0 && cut && s.rconSecret) {
        try {
          players = playersIn(await command(s, "list", signal)) ?? players;
        } catch (err) {
          if (!(err instanceof PluginError)) throw err;
          note = `Only some are named: ${err.message}`;
        }
      }
      return [
        `${where}: up${st.version ? `, ${st.version}` : ""}`,
        st.motd && `MOTD: ${st.motd}`,
        `Players: ${st.online} of ${st.max}${players.length ? `: ${players.join(", ")}` : ""}`,
        note,
      ]
        .filter(Boolean)
        .join("\n");
    };

    const tools = [
      tool({
        name: "minecraft_status",
        description:
          "Whether Minecraft servers are up, their version and MOTD, and who's on: how many players, the most there can be, and their names. Without server, every server. Players pick their names, so it's untrusted.",
        access: "read",
        untrusted: true,
        label: "Checking Minecraft",
        schema: z.object({ server: serverField }),
        describe: ({ server }) =>
          server ? `Checked ${nameOf(server)}` : "Checked the Minecraft servers",
        run: async ({ server }, { signal }) => {
          const list = server === undefined ? config.servers : [pick(server)];
          return (await Promise.all(list.map((s) => statusOf(s, signal)))).join("\n\n");
        },
      }),
      tool({
        name: "minecraft_command",
        description:
          "Run one server command over RCON, as the server's console would, and give back its answer. Plain queries (list, whitelist list, banlist, seed, time query, gamerule <rule>, data get…) run at once; anything else goes to the safety review. What it answers can quote players: untrusted.",
        access: "write",
        untrusted: true,
        label: "Running a Minecraft command",
        schema: z.object({ server: serverField, command: Command }),
        describe: ({ server, command }) => `On ${nameOf(server)}: ${command}`,
        looks: ({ command }) => looksOnly(command),
        kind: ({ command }) => (SENDS.has(head(command)) ? "send" : undefined),
        target: ({ server }) => nameOf(server),
        policy: ({ command }) => (looksOnly(command) ? covered(LOOKS) : ask(whyOf(command))),
        run: async ({ server, command: line }, { signal }) =>
          (await command(pick(server), line, signal)) || "It ran; the server said nothing back.",
      }),
    ];

    return ready(tools, {
      actions,
      guidance: `Minecraft servers: ${config.servers.map((s) => `${s.name} (${s.host}:${s.port}${s.rconSecret ? `, RCON password kept as ${secretPlaceholder(s.rconSecret)}` : ", no RCON"})`).join("; ")}. Who's on, the version and the MOTD: minecraft_status. Server commands (whitelist, op, kick, say, gamerule…): minecraft_command. To find where a player who's on last died: data get entity <name> LastDeathLocation. Logs (deaths, chat, who came and went) are in logs/latest.log on the server: read them over SSH. RCON's stop only stops a server; restart one over SSH, with systemd.`,
      test: async () => {
        const lines = await Promise.all(
          config.servers.map(async (s) => {
            const st = await ping({ host: s.host, port: s.port }).catch((err) => {
              throw new PluginError(`${s.name}: ${err.message}`);
            });
            if (s.rconSecret) await command(s, "list");
            return `${s.name}: ${st.online} of ${st.max} on${s.rconSecret ? ", RCON works" : ""}.`;
          }),
        );
        return lines.join(" ");
      },
    });
  },
});
