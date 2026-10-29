// Kuma's own API is socket.io, so this reads its Prometheus endpoint (/metrics) instead.

import { definePlugin, httpApi, needsSetup, PluginError, ready, tool } from "@hatbot/plugin-sdk";
import { z } from "zod";

const STATUS: Record<number, Status> = { 0: "down", 1: "up", 2: "pending", 3: "maintenance" };
type Status = "down" | "up" | "pending" | "maintenance";
/** Down ones first: what the owner asks about. */
const ORDER: (Status | "unknown")[] = ["down", "pending", "maintenance", "up", "unknown"];

export type Sample = { name: string; labels: Record<string, string>; value: number };

/**
 * Prometheus' text format: `name{label="value",...} value [timestamp]`, with \\, \" and \n escaped in
 * label values. HELP, TYPE and other '#' lines are skipped, as are lines that don't parse.
 */
const LINE =
  /^([a-zA-Z_:][\w:]*)(?:\{\s*((?:[a-zA-Z_]\w*\s*=\s*"(?:[^"\\]|\\.)*"\s*(?:,\s*)?)*)\})?\s+(\S+)/;
const LABEL = /([a-zA-Z_]\w*)\s*=\s*"((?:[^"\\]|\\.)*)"/g;

export function parseMetrics(text: string): Sample[] {
  return text.split("\n").flatMap((line) => {
    const m = LINE.exec(line.trim());
    const value = Number(m?.[3]);
    if (!m || Number.isNaN(value)) return [];
    const labels: Record<string, string> = {};
    for (const [, key = "", v = ""] of (m[2] ?? "").matchAll(LABEL))
      labels[key] = v.replace(/\\(.)/g, (_, c) => (c === "n" ? "\n" : c));
    return [{ name: m[1] ?? "", labels, value }];
  });
}

type Monitor = {
  name: string;
  type: string;
  url: string;
  hostname: string;
  port: string;
  status?: number;
  responseTime?: number;
  certDays?: number;
  certValid?: number;
};

/** Kuma writes missing fields as "null", and gives every new monitor the url "https://". */
const present = (v: string | undefined) =>
  v && v !== "null" && v !== "undefined" && !/^https?:\/\/$/.test(v) ? v : "";

export function monitorsFrom(samples: Sample[]): Monitor[] {
  const byName = new Map<string, Monitor>();
  for (const s of samples) {
    const name = s.labels.monitor_name;
    if (!s.name.startsWith("monitor_") || name === undefined) continue;
    let m = byName.get(name);
    if (!m) {
      m = {
        name,
        type: present(s.labels.monitor_type),
        url: present(s.labels.monitor_url),
        hostname: present(s.labels.monitor_hostname),
        port: present(s.labels.monitor_port),
      };
      byName.set(name, m);
    }
    if (s.name === "monitor_status") m.status = s.value;
    else if (s.name === "monitor_response_time") m.responseTime = s.value;
    else if (s.name === "monitor_cert_days_remaining") m.certDays = s.value;
    else if (s.name === "monitor_cert_is_valid") m.certValid = s.value;
  }
  return [...byName.values()].sort(
    (a, b) =>
      ORDER.indexOf(statusOf(a)) - ORDER.indexOf(statusOf(b)) || a.name.localeCompare(b.name),
  );
}

const statusOf = (m: Monitor) =>
  (m.status === undefined ? undefined : STATUS[m.status]) ?? "unknown";

const target = (m: Monitor) => {
  const host = m.hostname ? `${m.hostname}${m.port && m.port !== "0" ? `:${m.port}` : ""}` : "";
  const web = /^(http|keyword|json-query|real-browser|grpc-keyword)$/.test(m.type);
  return (web ? m.url || host : host || m.url) || "";
};

const line = (m: Monitor) =>
  [
    `${m.name}: ${statusOf(m)}`,
    [m.type, target(m)].filter(Boolean).join(" "),
    m.responseTime !== undefined && m.responseTime >= 0 ? `${Math.round(m.responseTime)} ms` : "",
    m.certDays !== undefined
      ? `cert ${m.certDays} days left${m.certValid === 0 ? " (invalid)" : ""}`
      : "",
  ]
    .filter(Boolean)
    .join(", ");

const distance = (a: string, b: string) => {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++)
      cur[j] = Math.min(
        (prev[j] ?? 0) + 1,
        (cur[j - 1] ?? 0) + 1,
        (prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    prev = cur;
  }
  return prev[b.length] ?? 0;
};

export const uptimeKumaPlugin = definePlugin({
  id: "uptimekuma",
  name: "Uptime Kuma",
  description: "Monitors' status, response times and certificates, read-only",
  env: [
    { name: "UPTIME_KUMA_URL", hint: "http://uptime.lan:3001" },
    { name: "UPTIME_KUMA_API_KEY", secret: true },
  ],
  config: z.object({}),
  start: ({ env }) => {
    const base = env.UPTIME_KUMA_URL?.replace(/\/$/, "");
    const key = env.UPTIME_KUMA_API_KEY;
    if (!base || !key)
      return needsSetup(
        "Create an API key in Uptime Kuma (Settings → API Keys), and set it and Uptime Kuma's address below.",
      );

    // Kuma takes an API key as basic auth's password, with no username.
    const { send } = httpApi("Uptime Kuma", base, {
      authorization: `Basic ${Buffer.from(`:${key}`).toString("base64")}`,
    });
    const monitors = async (): Promise<Monitor[]> => {
      const res = await send("GET", "/metrics").catch((err) => {
        if (err instanceof PluginError && (err.status === 401 || err.status === 403))
          throw new PluginError(
            `Uptime Kuma refused the API key (${err.status}). Check UPTIME_KUMA_API_KEY in Settings → Uptime Kuma: the key may be expired or turned off.`,
          );
        throw err;
      });
      const text = await res.text();
      if (/^\s*</.test(text))
        throw new PluginError(
          `${base}/metrics returned a web page, not metrics: is UPTIME_KUMA_URL Uptime Kuma's address?`,
        );
      return monitorsFrom(parseMetrics(text));
    };

    const tools = [
      tool({
        name: "uptimekuma_monitors",
        description:
          "Every Uptime Kuma monitor in a line: status, type and target, response time, and days left on its certificate. Down ones first.",
        access: "read",
        label: "Checking Uptime Kuma",
        schema: z.object({
          status: z
            .enum(["down", "up", "pending", "maintenance"])
            .optional()
            .describe("Only monitors in this state"),
        }),
        describe: ({ status }) => (status ? `Listed ${status} monitors` : "Listed monitors"),
        run: async ({ status }) => {
          const list = (await monitors()).filter((m) => !status || statusOf(m) === status);
          return (
            list.map(line).join("\n") || (status ? `No monitors are ${status}.` : "No monitors.")
          );
        },
      }),
      tool({
        name: "uptimekuma_monitor",
        description: "One Uptime Kuma monitor by name, with all its metrics.",
        access: "read",
        label: "Checking Uptime Kuma",
        schema: z.object({ name: z.string().min(1).max(200).describe("The monitor's name") }),
        describe: ({ name }) => `Checked monitor ${name}`,
        run: async ({ name }) => {
          const all = await monitors();
          const want = name.trim().toLowerCase();
          const m = all.find((x) => x.name.toLowerCase() === want);
          if (!m) {
            const close = all
              .map((x) => {
                const n = x.name.toLowerCase();
                const d = n.includes(want) || want.includes(n) ? 0 : distance(n, want);
                return { name: x.name, d };
              })
              .filter((x) => x.d <= Math.max(2, Math.floor(want.length / 3)))
              .sort((a, b) => a.d - b.d)
              .slice(0, 5)
              .map((x) => x.name);
            throw new PluginError(
              `No monitor named "${name}".${close.length ? ` Did you mean ${close.map((c) => `"${c}"`).join(", ")}?` : " uptimekuma_monitors lists them all."}`,
            );
          }
          return [
            `${m.name}: ${statusOf(m)}`,
            m.type && `Type: ${m.type}`,
            m.url && `URL: ${m.url}`,
            m.hostname && `Host: ${m.hostname}`,
            m.port && m.port !== "0" && `Port: ${m.port}`,
            m.responseTime !== undefined &&
              m.responseTime >= 0 &&
              `Response time: ${Math.round(m.responseTime)} ms`,
            m.certDays !== undefined && `Certificate: ${m.certDays} days left`,
            m.certValid !== undefined && `Certificate valid: ${m.certValid === 1 ? "yes" : "no"}`,
          ]
            .filter(Boolean)
            .join("\n");
        },
      }),
    ];

    return ready(tools, {
      guidance: `Uptime Kuma at ${base} watches the owner's services. uptimekuma_monitors shows every monitor's status (down ones first), what it checks, its response time and days left on its certificate; uptimekuma_monitor shows one. It's read-only: it can't pause, edit or add monitors, so tell the owner to do that in Kuma.`,
      test: async () => {
        const all = await monitors();
        const down = all.filter((m) => statusOf(m) === "down").length;
        return `Sees ${all.length} monitors, ${down ? `${down} down` : "none down"}.`;
      },
      signals: async () =>
        (await monitors())
          .filter((m) => statusOf(m) === "down")
          .map((m) => ({ key: `down:${m.name}`, text: `Uptime Kuma: ${line(m)}` })),
    });
  },
});
