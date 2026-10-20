// Home Assistant: look at the house's devices and sensors, their history, and control them through
// HA's REST API with a long-lived access token. Everyday device control just runs; anything that
// changes Home Assistant itself asks first, and whatever lets someone in (locks, alarms, covers, and
// the entities you mark, such as a gate on a switch) always waits for you.
import { z } from "zod";
import {
  allow,
  ask,
  askAlways,
  definePlugin,
  httpApi,
  needsSetup,
  PluginError,
  ready,
  tool,
} from "../plugin";

const ENTITY_ID = /^[a-z0-9_]+\.[a-z0-9_]+$/;
const EntityId = z
  .string()
  .regex(ENTITY_ID, "domain.object_id")
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

/**
 * Domains whose states and attributes are the device's own, with no text from outside in them. The
 * rest can carry what strangers wrote: a phone's last notification, a mail's subject, an update's
 * release notes, a to-do item, what's playing.
 */
const TRUSTED_DOMAINS = new Set(
  (
    "light switch fan climate binary_sensor cover lock alarm_control_panel input_boolean " +
    "input_number humidifier water_heater vacuum siren valve number counter timer button scene " +
    "script automation sun zone person"
  ).split(" "),
);
/** States that can't say anything: a number, a time, or a word Home Assistant's own states use. */
const NUMBER = /^[+-]?\d+(\.\d+)?([eE][+-]?\d+)?$/;
const TIME = /^(\d{4}-\d{2}-\d{2}([T ][\d:.]+([+-]\d{2}:\d{2}|Z)?)?|\d{1,2}:\d{2}(:\d{2})?)$/;
const PLAIN_WORDS = new Set(
  (
    "on off unknown unavailable none true false ok problem home not_home open closed opening " +
    "closing locked unlocked locking unlocking jammed playing paused idle standby buffering " +
    "armed_away armed_home armed_night armed_vacation armed_custom_bypass disarmed pending " +
    "triggered arming disarming heat cool heat_cool auto dry fan_only active inactive running " +
    "stopped cleaning docked returning error above_horizon below_horizon charging discharging " +
    "not_charging full low medium high normal eco detected clear online offline connected " +
    "disconnected"
  ).split(" "),
);
/** What lists show instead of a state that is free text from outside. */
const TEXT_STATE = "[text]";
/**
 * A state to show where output is trusted: free text from outside is left out. An enum sensor's
 * own options are fine.
 */
const shownState = (entityId: string, state: string, options?: unknown) =>
  TRUSTED_DOMAINS.has(domainOf(entityId)) ||
  NUMBER.test(state) ||
  TIME.test(state) ||
  PLAIN_WORDS.has(state.toLowerCase()) ||
  (Array.isArray(options) && options.includes(state))
    ? state
    : TEXT_STATE;
/**
 * Domains whose names often come from outside: what a phone calls itself on the wifi, what a
 * speaker announces, a shared calendar's or list's name. Trusted output leaves their names out.
 */
const NAMED_OUTSIDE = new Set(["device_tracker", "media_player", "calendar", "todo"]);

/**
 * Everyday device control: runs without asking. Not notify: it can message anyone. A switch or a
 * button that opens a gate is one of the owner's access entities, which always ask.
 */
const EVERYDAY = new Set(
  (
    "light switch fan media_player climate scene button number select vacuum humidifier " +
    "water_heater remote tts counter timer"
  ).split(" "),
);

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

/**
 * Who can get in: these always ask, whatever Haiku's review says, and as "access", which a locked
 * phone's notification can't approve.
 */
const ACCESS = new Set(["lock", "alarm_control_panel", "cover"]);
/**
 * Covers that only shade a window: no way in (2026-10-20, the owner's choice). Doors, garages,
 * gates, windows and covers with no class still let someone in.
 */
const SHADES = new Set(["blind", "curtain", "shade", "shutter", "awning"]);
const askAccess = (why: string) => askAlways(why, "access");
const careful = (domain: string) =>
  ACCESS.has(domain) ? askAccess(CAREFUL[domain] ?? "") : ask(CAREFUL[domain] ?? "");

/** Targets that stand for many entities: Home Assistant resolves them, so they can hide a lock. */
const INDIRECT = ["area_id", "device_id", "label_id", "floor_id"];

const domainOf = (entityId: string) => entityId.split(".")[0] ?? "";
const time = (iso: string) => iso.slice(0, 16).replace("T", " ");
const listOf = (ids: string | string[] | undefined) =>
  ids === undefined ? [] : Array.isArray(ids) ? ids : [ids];
/** An id as Home Assistant reads it: it lowercases ids, and "ALL", before acting on them. */
const idOf = (id: string) => id.trim().toLowerCase();
/** Entity ids as Home Assistant reads them: one, a list, or a comma-separated string. */
const idsOf = (ids: unknown): string[] =>
  (Array.isArray(ids) ? ids : ids === undefined || ids === null ? [] : [ids])
    .flatMap((x) => String(x).split(","))
    .map(idOf)
    .filter(Boolean);

const Config = z.object({
  /**
   * Entities that let someone in besides locks, alarms and covers, e.g. a gate on a switch, a garage
   * button, or a script or an integration's scene that opens a door: every change to them, and to a
   * scene or group that holds one, waits for the owner.
   */
  access: z.array(z.string().trim().toLowerCase().regex(ENTITY_ID, "domain.object_id")).default([]),
});

export const homeassistantPlugin = definePlugin({
  id: "homeassistant",
  name: "Home Assistant",
  description: "The house's devices and sensors: look at them and control them",
  env: [
    { name: "HOMEASSISTANT_URL", hint: "http://homeassistant.lan:8123" },
    { name: "HOMEASSISTANT_TOKEN", secret: true },
  ],
  config: Config,
  start: ({ env, config }) => {
    const base = env.HOMEASSISTANT_URL?.replace(/\/$/, "");
    const token = env.HOMEASSISTANT_TOKEN;
    if (!base || !token)
      return needsSetup(
        "Create a long-lived access token in Home Assistant (your profile, Security), and set it and Home Assistant's address below.",
      );

    const { api } = httpApi("Home Assistant", `${base}/api`, {
      authorization: `Bearer ${token}`,
      accept: "application/json",
    });

    /** `whole`: the state as it is, for output already marked untrusted. */
    const stateLine = (s: State, whole = false) => {
      const unit = s.attributes.unit_of_measurement;
      const name =
        whole || !NAMED_OUTSIDE.has(domainOf(s.entity_id)) ? s.attributes.friendly_name : undefined;
      const state = whole ? s.state : shownState(s.entity_id, s.state, s.attributes.options);
      return `${s.entity_id}: ${state}${unit ? ` ${unit}` : ""}${name ? ` (${name})` : ""}`;
    };

    /** Entities the owner marked as letting someone in. */
    const marked = new Set(config.access);
    /** Each cover's device class, from the last look at every state. */
    const coverClass = new Map<string, string>();
    const shade = (id: string) =>
      domainOf(id) === "cover" && !marked.has(id) && SHADES.has(coverClass.get(id) ?? "");
    const isAccess = (id: string) => (ACCESS.has(domainOf(id)) && !shade(id)) || marked.has(id);
    const accessWhy = (id: string) =>
      marked.has(id)
        ? `The owner asked to approve every change to ${id}.`
        : (CAREFUL[domainOf(id)] ?? "");
    /**
     * What each scene and group holds (old-style group.* and the light, switch or cover group
     * helpers), from the last look at every state; a policy can't wait to ask. A scene from an
     * integration has no list: what it sets isn't known.
     */
    const members = new Map<string, string[]>();
    const opaque = new Set<string>();
    let learned = false;
    const membersOf = (s: State) =>
      Array.isArray(s.attributes.entity_id) ? idsOf(s.attributes.entity_id) : null;
    const learn = (all: State[]) => {
      members.clear();
      opaque.clear();
      coverClass.clear();
      learned = true;
      for (const s of all) {
        const id = idOf(s.entity_id);
        if (domainOf(id) === "cover" && typeof s.attributes.device_class === "string")
          coverClass.set(id, s.attributes.device_class);
        const held = membersOf(s);
        if (held) members.set(id, held);
        else if (domainOf(id) === "scene") opaque.add(id);
      }
    };
    /** The ids and everything they hold, through groups in groups. */
    const expand = (ids: string[]) => {
      const out = new Set<string>();
      const walk = (id: string) => {
        if (out.has(id)) return;
        out.add(id);
        for (const m of members.get(id) ?? []) walk(m);
      };
      for (const id of ids) walk(id);
      return [...out];
    };
    let looked = 0;
    /** Looks at every state in the background, at most once a minute. */
    const relearn = () => {
      if (Date.now() - looked < 60_000) return;
      looked = Date.now();
      void api<State[]>("GET", "/states")
        .then(learn)
        .catch(() => {});
    };
    relearn();
    /** The entities a call names, wherever it names them. */
    const targetsOf = (entityId: unknown, data: Record<string, unknown> | undefined) => {
      const target = (data?.target ?? {}) as Record<string, unknown>;
      return [
        ...idsOf(entityId),
        ...idsOf(data?.entity_id),
        ...idsOf(target.entity_id),
        ...idsOf(Object.keys((data?.entities as Record<string, unknown> | undefined) ?? {})),
      ];
    };

    const tools = [
      tool({
        name: "homeassistant_states",
        description: `Home Assistant's entities with their state, friendly name and unit, sorted by id. Filter by domain (light, sensor, climate…) and/or a search over ids and names; at most ${MAX_ENTITIES} are listed. A state that is free text from outside (a notification, a mail's subject) shows as ${TEXT_STATE}; homeassistant_entity reads it, as untrusted.`,
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
          const all = await api<State[]>("GET", "/states");
          learn(all);
          const list = all
            .filter((s) => !domain || domainOf(s.entity_id) === domain)
            .filter(
              (s) =>
                !needle ||
                s.entity_id.toLowerCase().includes(needle) ||
                (s.attributes.friendly_name ?? "").toLowerCase().includes(needle),
            )
            .sort((a, b) => a.entity_id.localeCompare(b.entity_id));
          if (!list.length) return "No matching entities.";
          const out = list.slice(0, MAX_ENTITIES).map((s) => stateLine(s));
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
          "One entity's state, when it last changed, and its attributes. Apart from plain devices (lights, switches, climate, binary sensors, locks, covers and the like), entities can carry text from outside, such as sensors, calendars, to-do lists, updates and media players: untrusted.",
        access: "read",
        untrusted: ({ entity_id }) => !TRUSTED_DOMAINS.has(domainOf(entity_id)),
        label: "Checking Home Assistant",
        schema: z.object({ entity_id: EntityId }),
        describe: ({ entity_id }) => `Read ${entity_id}`,
        run: async ({ entity_id }) => {
          const s = await api<State>("GET", `/states/${encodeURIComponent(entity_id)}`);
          const attrs = JSON.stringify(s.attributes);
          return [
            stateLine(s, true),
            `Last changed: ${time(s.last_changed)} UTC`,
            `Attributes: ${attrs.length > MAX_ATTRIBUTES ? `${attrs.slice(0, MAX_ATTRIBUTES)}… (cut)` : attrs}`,
          ].join("\n");
        },
      }),
      tool({
        name: "homeassistant_history",
        description:
          "How one or a few entities' states changed over the last hours (1 to 168, 24 by default), oldest first, times in UTC. Free-text states show as [text].",
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
              ...run.slice(cut).map((e) => `  ${time(e.last_changed)} ${shownState(id, e.state)}`),
            );
          }
          return out.join("\n") || `No history for ${ids.join(", ")} in the last ${hours} hours.`;
        },
      }),
      tool({
        name: "homeassistant_call_service",
        description:
          'Call a Home Assistant service, e.g. domain "light", service "turn_on", entity_id "light.kitchen", data {"brightness_pct": 40}. Locks, alarms, covers (doors, garage, gates, windows; not blinds, curtains, shades, shutters or awnings), the entities the owner marked, and scenes, groups, areas, devices, labels or floors that could include them always wait for the owner. Scenes from an integration, scripts, automations, notifications, Home Assistant itself and other services that aren\'t everyday device control need approval (the safety review or the owner).',
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
          // Who can get in comes first, whatever the domain: homeassistant.toggle on a cover, a
          // scene that unlocks a door, or a stray entity_id in data.
          const targets = targetsOf(entity_id, data);
          const odd = targets.find((t) => !ENTITY_ID.test(t) && t !== "all" && t !== "none");
          if (odd)
            return askAccess(
              `${JSON.stringify(odd)} isn't an entity id as Home Assistant writes them, so what it reaches isn't known.`,
            );
          const reached = expand(targets);
          const door = reached.find(isAccess);
          if (door) return askAccess(accessWhy(door));
          // Home Assistant resolves areas, devices, labels, floors and "all" itself. A service only
          // acts on its own domain's entities, so they matter where a door could be among them.
          const target = (data?.target ?? {}) as Record<string, unknown>;
          const many =
            targets.includes("all") ||
            INDIRECT.some((k) => data?.[k] !== undefined || target[k] !== undefined);
          if (
            many &&
            (ACCESS.has(domain) ||
              ["homeassistant", "scene"].includes(domain) ||
              [...marked].some((id) => domainOf(id) === domain))
          )
            return askAccess(
              "It acts on a whole area, device, label or floor, which can include a lock, the alarm, a door or a gate.",
            );
          // A switch group can hold a gate on a switch: until the states are known, any entity in
          // a marked one's domain could be such a group.
          const unseen = targets.filter((t) =>
            ["scene", "group"].includes(domainOf(t))
              ? !members.has(t) && !opaque.has(t)
              : !learned && [...marked].some((id) => domainOf(id) === domainOf(t)),
          );
          if (unseen.length) {
            // So the next call knows it, if Home Assistant was down when this one started.
            relearn();
            return askAccess(
              `It isn't known yet what ${unseen.join(", ")} sets or holds, and a scene or group can open a door.`,
            );
          }
          const unknown = targets.find((t) => opaque.has(t));
          if (unknown)
            return ask(
              `${unknown} comes from an integration, which doesn't say what it sets. If it can open a door, mark it in Settings.`,
            );
          if (domain === "recorder" && service === "purge")
            return ask("It deletes recorded history.", "delete");
          const shades = domain === "cover" && targets.length > 0 && targets.every(shade);
          if (CAREFUL[domain] && !shades) return careful(domain);
          if (!shades && !EVERYDAY.has(domain) && !domain.startsWith("input_"))
            return ask(`It calls ${domain}.${service}, which isn't everyday device control.`);
          for (const t of reached) {
            const domain = domainOf(t);
            if (CAREFUL[domain] && !shade(t)) return careful(domain);
          }
          return allow();
        },
        run: async ({ domain, service, entity_id, data }) => {
          // The policy went by the scenes and groups as last seen: one changed since could now open
          // a door.
          for (const id of targetsOf(entity_id, data)) {
            if (shade(id)) {
              const now = await api<State>("GET", `/states/${encodeURIComponent(id)}`);
              const cls = now.attributes.device_class;
              if (typeof cls !== "string" || !SHADES.has(cls)) {
                coverClass.delete(id);
                throw new PluginError(
                  `${id} isn't a blind, curtain, shade, shutter or awning any more, so it waits for the owner: call it again.`,
                );
              }
            }
            const before = members.has(id) ? expand([id]) : null;
            if (!before) continue;
            const now = membersOf(await api<State>("GET", `/states/${encodeURIComponent(id)}`));
            members.set(id, now ?? []);
            const added = expand([id]).filter((e) => isAccess(e) && !before.includes(e));
            if (added.length)
              throw new PluginError(
                `${id} now also ${domainOf(id) === "scene" ? "sets" : "holds"} ${added.join(", ")}, so it waits for the owner: call it again.`,
              );
          }
          const changed = await api<State[]>("POST", `/services/${domain}/${service}`, {
            ...data,
            ...(entity_id ? { entity_id } : {}),
          });
          if (!Array.isArray(changed) || !changed.length)
            return `Called ${domain}.${service}; no states changed (yet).`;
          return [`Called ${domain}.${service}; now:`, ...changed.map((s) => stateLine(s))].join(
            "\n",
          );
        },
      }),
    ];

    return ready(tools, {
      guidance: `Home Assistant at ${base}: the house's lights, switches, climate, media players, sensors and the rest. Find entities with homeassistant_states (filter by domain or search), read one with homeassistant_entity, see how it changed with homeassistant_history, and control devices with homeassistant_call_service. Locks, alarms, covers other than blinds, curtains, shades, shutters and awnings${marked.size ? `, ${[...marked].join(", ")}` : ""} and scenes or groups that hold them always wait for the owner; scenes from an integration, scripts, automations, notifications and Home Assistant itself need approval (the safety review or the owner).`,
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
