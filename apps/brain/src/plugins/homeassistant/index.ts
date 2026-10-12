// Home Assistant: look at the house's devices and sensors, their history, and control them through
// HA's REST API with a long-lived access token. Everyday device control just runs; locks, alarms,
// covers (doors, garage, gates) and anything that changes Home Assistant itself ask the owner first.
import { z } from "zod";
import { allow, ask, definePlugin, needsSetup, PluginError, ready, tool } from "../plugin";

const EntityId = z
  .string()
  .regex(/^[a-z0-9_]+\.[a-z0-9_]+$/, "domain.object_id")
  .describe('An entity id, e.g. "light.kitchen"');
const Domain = z.string().regex(/^[a-z0-9_]+$/, "a lowercase domain");

/** How many entities homeassistant_states lists before it cuts. */
const MAX_ENTITIES = 300;
/** How much of an entity's attributes homeassistant_entity shows. */
const MAX_ATTRIBUTES = 4000;
/** State changes per entity homeassistant_history shows: the latest ones. */
const MAX_CHANGES = 200;

type State = {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown> & { friendly_name?: string; unit_of_measurement?: string };
  last_changed: string;
  last_updated?: string;
};

/** Domains whose attributes carry text from outside: event titles, to-do items, what's playing. */
const UNTRUSTED_DOMAINS = new Set([
  "calendar",
  "todo",
  "media_player",
  "event",
  "image",
  "feedreader",
  "mailbox",
]);

/** Everyday device control: runs without asking. */
const EVERYDAY = new Set([
  "light",
  "switch",
  "fan",
  "media_player",
  "climate",
  "scene",
  "button",
  "number",
  "select",
  "vacuum",
  "humidifier",
  "water_heater",
  "remote",
  "tts",
  "notify",
  "counter",
  "timer",
]);

/** Domains that ask, and why, in a sentence. */
const CAREFUL: Record<string, string> = {
  lock: "Unlocking or locking changes who can get in.",
  alarm_control_panel: "Arming or disarming the alarm changes who can get in unnoticed.",
  cover: "Covers include doors, garage doors and gates: opening one can let someone in.",
  homeassistant: "It acts on Home Assistant itself: restart, stop, reload, or any device at once.",
  hassio: "It manages Home Assistant's add-ons, backups and host.",
  recorder: "It changes what Home Assistant records.",
  backup: "It makes or restores Home Assistant's backups.",
  script: "A script can do anything Home Assistant can, including unlocking doors.",
  automation: "Automations run on their own: changing one changes what the house does unattended.",
  shell_command: "It runs a command on the Home Assistant host.",
  rest_command: "It sends a request to another service.",
};

const domainOf = (entityId: string) => entityId.split(".")[0] ?? "";
const time = (iso: string) => iso.slice(0, 16).replace("T", " ");
const listOf = (ids: string | string[] | undefined) =>
  ids === undefined ? [] : Array.isArray(ids) ? ids : [ids];

export const homeassistantPlugin = definePlugin({
  id: "homeassistant",
  name: "Home Assistant",
  description: "The house's devices and sensors: look at them and control them",
  secrets: ["HOMEASSISTANT_URL", "HOMEASSISTANT_TOKEN"],
  config: z.object({}),
  start: ({ env }) => {
    const base = env.HOMEASSISTANT_URL?.replace(/\/$/, "");
    const token = env.HOMEASSISTANT_TOKEN;
    if (!base || !token)
      return needsSetup(
        "Create a long-lived access token in Home Assistant (your profile, Security) and put HOMEASSISTANT_URL and HOMEASSISTANT_TOKEN in /etc/hatbot/homeassistant.env on the brain, then restart it.",
      );

    const api = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
      let res: Response;
      try {
        res = await fetch(`${base}/api${path}`, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            accept: "application/json",
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(30_000),
        });
      } catch (err) {
        throw new PluginError(`Can't reach Home Assistant: ${(err as Error).message}`);
      }
      if (!res.ok) {
        // HA answers {"message": ...} for most errors, plain text ("401: Unauthorized") for some.
        const text = await res.text().catch(() => "");
        let detail = text;
        try {
          detail = (JSON.parse(text) as { message?: string }).message ?? text;
        } catch {}
        throw new PluginError(
          `Home Assistant said ${res.status}${detail ? `: ${String(detail).slice(0, 300)}` : ""}`,
        );
      }
      return (await res.json()) as T;
    };

    const stateLine = (s: State) => {
      const unit = s.attributes.unit_of_measurement;
      const name = s.attributes.friendly_name;
      return `${s.entity_id}: ${s.state}${unit ? ` ${unit}` : ""}${name ? ` (${name})` : ""}`;
    };

    const tools = [
      tool({
        name: "homeassistant_states",
        description: `Home Assistant's entities with their state, friendly name and unit, sorted by id. Filter by domain (light, sensor, climate…) and/or a search over ids and names; at most ${MAX_ENTITIES} are listed.`,
        access: "read",
        label: "Checking Home Assistant",
        schema: z.object({
          domain: Domain.optional().describe('Only this domain, e.g. "light"'),
          search: z
            .string()
            .max(100)
            .optional()
            .describe("Only entities whose id or friendly name contains this"),
        }),
        describe: ({ domain, search }) =>
          `Listed Home Assistant entities${domain ? ` in ${domain}` : ""}${search ? ` matching "${search}"` : ""}`,
        run: async ({ domain, search }) => {
          const needle = search?.toLowerCase();
          const list = (await api<State[]>("GET", "/states"))
            .filter((s) => !domain || domainOf(s.entity_id) === domain)
            .filter(
              (s) =>
                !needle ||
                s.entity_id.toLowerCase().includes(needle) ||
                (s.attributes.friendly_name ?? "").toLowerCase().includes(needle),
            )
            .sort((a, b) => a.entity_id.localeCompare(b.entity_id));
          if (!list.length) return "No matching entities.";
          const out = list.slice(0, MAX_ENTITIES).map(stateLine);
          if (list.length > MAX_ENTITIES)
            out.push(
              `…and ${list.length - MAX_ENTITIES} more; narrow it down with domain or search.`,
            );
          return out.join("\n");
        },
      }),
      tool({
        name: "homeassistant_entity",
        description:
          "One entity's state, when it last changed, and its attributes. Calendar, to-do, media player and similar entities carry text from outside: untrusted.",
        access: "read",
        untrusted: ({ entity_id }) => UNTRUSTED_DOMAINS.has(domainOf(entity_id)),
        label: "Checking Home Assistant",
        schema: z.object({ entity_id: EntityId }),
        describe: ({ entity_id }) => `Read ${entity_id}`,
        run: async ({ entity_id }) => {
          const s = await api<State>("GET", `/states/${encodeURIComponent(entity_id)}`);
          const attrs = JSON.stringify(s.attributes);
          return [
            stateLine(s),
            `Last changed: ${time(s.last_changed)} UTC`,
            `Attributes: ${attrs.length > MAX_ATTRIBUTES ? `${attrs.slice(0, MAX_ATTRIBUTES)}… (cut)` : attrs}`,
          ].join("\n");
        },
      }),
      tool({
        name: "homeassistant_history",
        description:
          "How one or a few entities' states changed over the last hours (1 to 168, 24 by default), oldest first, times in UTC.",
        access: "read",
        label: "Checking Home Assistant",
        schema: z.object({
          entity_id: z.union([EntityId, z.array(EntityId).min(1).max(10)]),
          hours: z.number().int().min(1).max(168).default(24),
        }),
        describe: ({ entity_id, hours }) =>
          `History of ${listOf(entity_id).join(", ")} (${hours} h)`,
        run: async ({ entity_id, hours }) => {
          const ids = listOf(entity_id);
          const start = new Date(Date.now() - hours * 3_600_000).toISOString();
          // minimal_response: after the first, entries are only {state, last_changed}.
          const runs = await api<{ entity_id?: string; state: string; last_changed: string }[][]>(
            "GET",
            `/history/period/${encodeURIComponent(start)}?filter_entity_id=${ids.join(",")}&minimal_response&no_attributes`,
          );
          const out: string[] = [];
          for (const run of runs) {
            const id = run[0]?.entity_id ?? "?";
            const cut = run.length > MAX_CHANGES ? run.length - MAX_CHANGES : 0;
            out.push(
              `${id} (${run.length} state${run.length === 1 ? "" : "s"}):`,
              ...(cut ? [`  …${cut} earlier ones left out`] : []),
              ...run.slice(cut).map((e) => `  ${time(e.last_changed)} ${e.state}`),
            );
          }
          return out.join("\n") || `No history for ${ids.join(", ")} in the last ${hours} hours.`;
        },
      }),
      tool({
        name: "homeassistant_call_service",
        description:
          'Call a Home Assistant service, e.g. domain "light", service "turn_on", entity_id "light.kitchen", data {"brightness_pct": 40}. Everyday device control runs at once; locks, alarms, covers, scripts, automations and Home Assistant itself ask the owner first.',
        access: "write",
        label: "Controlling Home Assistant",
        schema: z.object({
          domain: Domain,
          service: z.string().regex(/^[a-z0-9_]+$/, "a lowercase service"),
          entity_id: z.union([EntityId, z.array(EntityId).min(1).max(50)]).optional(),
          data: z.record(z.string(), z.unknown()).optional().describe("The service's other fields"),
        }),
        describe: ({ domain, service, entity_id }) =>
          `${domain}.${service}${entity_id ? ` ${listOf(entity_id).join(", ")}` : ""}`,
        policy: ({ domain, service, entity_id, data }) => {
          if (domain === "recorder" && service === "purge")
            return ask("It deletes recorded history.", "delete");
          if (CAREFUL[domain]) return ask(CAREFUL[domain]);
          if (!EVERYDAY.has(domain) && !domain.startsWith("input_"))
            return ask(`It calls ${domain}.${service}, which isn't everyday device control.`);
          // A scene or a stray entity_id in data can still reach a lock or a garage door.
          const targets = [
            ...listOf(entity_id),
            ...listOf(data?.entity_id as string | string[] | undefined),
            ...Object.keys((data?.entities as Record<string, unknown> | undefined) ?? {}),
          ];
          for (const t of targets) {
            const why = CAREFUL[domainOf(String(t))];
            if (why) return ask(why);
          }
          return allow();
        },
        run: async ({ domain, service, entity_id, data }) => {
          const changed = await api<State[]>("POST", `/services/${domain}/${service}`, {
            ...data,
            ...(entity_id ? { entity_id } : {}),
          });
          if (!Array.isArray(changed) || !changed.length)
            return `Called ${domain}.${service}; no states changed (yet).`;
          return [`Called ${domain}.${service}; now:`, ...changed.map(stateLine)].join("\n");
        },
      }),
    ];

    return ready(tools, {
      guidance: `Home Assistant at ${base}: the house's lights, switches, climate, media players, sensors and the rest. Find entities with homeassistant_states (filter by domain or search), read one with homeassistant_entity, see how it changed with homeassistant_history, and control devices with homeassistant_call_service. Everyday control runs at once; service calls for locks, alarms, covers (doors, garage, gates), scripts, automations and Home Assistant itself ask the owner first.`,
      test: async () => {
        await api("GET", "/");
        const config = await api<{ location_name?: string; version?: string }>(
          "GET",
          "/config",
        ).catch(() => null);
        const states = await api<unknown[]>("GET", "/states");
        return `Connected to ${config?.location_name ?? "Home Assistant"}${config?.version ? ` (Home Assistant ${config.version})` : ""}; it has ${states.length} entities.`;
      },
    });
  },
});
