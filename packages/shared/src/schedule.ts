// Schedules and triggers (PLAN.md §5.6, §8): types, request bodies, and cron in words.
import { z } from "zod";

export type Schedule = {
  id: number;
  name: string;
  /** Five-field cron, in the brain's time zone. Exactly one of cron and runAt is set. */
  cron: string | null;
  /** A one-off run. */
  runAt: string | null;
  /** What the run does: instructions for a background task that can't see the chat. */
  prompt: string;
  enabled: boolean;
  createdVia: "chat" | "owner";
  createdAt: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastTaskId: number | null;
};

const name = z.string().trim().min(1).max(80);
const prompt = z.string().trim().min(1).max(4000);
const when = {
  cron: z.string().trim().min(1).max(100).optional(),
  /** ISO date and time; without an offset it's the brain's local time. */
  at: z.string().trim().min(1).max(40).optional(),
};

export const CreateSchedule = z
  .object({ name, prompt, enabled: z.boolean().default(true), ...when })
  .refine((s) => Boolean(s.cron) !== Boolean(s.at), "set either cron or at");
export const UpdateSchedule = z
  .object({ name, prompt, enabled: z.boolean(), ...when })
  .partial()
  .refine((s) => !(s.cron && s.at), "set either cron or at");

export type TriggerKind = "webhook" | "kuma";

export type Trigger = {
  id: number;
  name: string;
  kind: TriggerKind;
  /** Payloads count as trusted content (PLAN.md §6.1). Uptime Kuma alerts always do. */
  trusted: boolean;
  /** What a run does with the event. */
  prompt: string;
  enabled: boolean;
  /** Where to send events. */
  url: string;
  createdAt: string;
  lastFiredAt: string | null;
  lastTaskId: number | null;
};
/** Only returned when the trigger is created or its secret is replaced. */
export type TriggerWithSecret = Trigger & { secret: string };

export const CreateTrigger = z.object({
  name,
  kind: z.enum(["webhook", "kuma"]),
  prompt,
  trusted: z.boolean().default(false),
});
export const UpdateTrigger = z
  .object({ name, prompt, trusted: z.boolean(), enabled: z.boolean() })
  .partial();

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const NICKNAMES: Record<string, string> = {
  "@hourly": "0 * * * *",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@weekly": "0 0 * * 0",
  "@monthly": "0 0 1 * *",
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
};

const num = (s: string) => (/^\d+$/.test(s) ? Number(s) : null);
const pad = (n: number) => String(n).padStart(2, "0");
const ordinal = (n: number) =>
  `${n}${n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th"}`;
const list = (items: string[]) =>
  items.length < 2 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;

/** "Every day at 08:00", "Weekdays at 07:30", "Every 15 minutes"; the expression itself when it's unusual. */
export function describeCron(expr: string): string {
  const fields = (NICKNAMES[expr.trim().toLowerCase()] ?? expr).trim().split(/\s+/);
  if (fields.length !== 5) return expr;
  const [min, hour, dom, mon, dow] = fields as [string, string, string, string, string];

  const every = /^\*\/(\d+)$/;
  if (hour === "*" && dom === "*" && mon === "*" && dow === "*") {
    if (min === "*") return "Every minute";
    const n = every.exec(min)?.[1];
    if (n) return `Every ${n} minutes`;
    if (num(min) !== null) return min === "0" ? "Every hour" : `Every hour at :${pad(Number(min))}`;
  }
  const m = num(min);
  if (m === null || mon !== "*") return expr;
  const n = every.exec(hour)?.[1];
  if (n && dom === "*" && dow === "*") return `Every ${n} hours`;
  const hours = hour.split(",").map(num);
  if (hours.some((h) => h === null)) return expr;
  const at = `at ${list(hours.map((h) => `${pad(h as number)}:${pad(m)}`))}`;

  if (dom === "*" && dow === "*") return `Every day ${at}`;
  if (dom === "*") {
    if (dow === "1-5") return `Weekdays ${at}`;
    if (dow === "0,6" || dow === "6,0" || dow === "6-7") return `Weekends ${at}`;
    const days = dow.split(",").map((d) => DAYS[Number(d) % 7]);
    if (dow.split(",").some((d) => num(d) === null || Number(d) > 7)) return expr;
    if (days.length === 1) return `Every ${days[0]} ${at}`;
    return `${list(days.map((d) => (d as string).slice(0, 3)))} ${at}`;
  }
  const day = num(dom);
  if (dow === "*" && day !== null && day >= 1 && day <= 31)
    return `${ordinal(day)} of the month ${at}`;
  return expr;
}
