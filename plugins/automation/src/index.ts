// Schedules, triggers and watchers, which start background tasks on their own, and the heartbeat and
// weekly report, which look over everything else.
import { definePlugin, hosts, ready, type Sandbox } from "@hatbot/plugin-sdk";
import { HATBOT_ID } from "@hatbot/shared";
import { z } from "zod";
import { type Deps, like, moveFrom, NEEDS } from "./deps";
import { HEARTBEAT_ORIGIN, Heartbeat } from "./heartbeat";
import { WeeklyReport } from "./report";
import { routes } from "./routes";
import { Schedules } from "./schedules";
import { automationTools } from "./tools";
import { Triggers } from "./triggers";
import { Watchers } from "./watch/service";

export { counts, numberIn } from "./watch/extract";
export { Heartbeat, Schedules, Triggers, Watchers, WeeklyReport };

export const automationPlugin = definePlugin({
  id: "automation",
  name: "Automation",
  description:
    "Schedules, webhooks, Uptime Kuma alerts and watchers that start tasks on their own, the heartbeat, and the weekly report.",
  config: z.object({}),
  defaultOn: true,
  allBots: true,
  needs: NEEDS,
  provides: ["schedules", "triggers", "watchers", "heartbeat", "report"],
  routes: ["/schedules", "/triggers", "/watchers", "/heartbeat", "/report"],
  publicRoutes: ["/hooks/:id", "/hooks/kuma/:id"],
  migrations: [
    // Kept by the brain before automation was a plugin.
    `UPDATE settings SET key = 'automation:heartbeat' WHERE key = 'heartbeat:state';
     UPDATE settings SET key = 'automation:report' WHERE key = 'report:last';`,
  ],
  uses: ["sandbox"],
  start: (ctx) => {
    const d: Deps = {
      ...hosts(ctx, NEEDS),
      db: ctx.db,
      desktop: ctx.optional<Sandbox>("sandbox") ?? undefined,
      store: ctx.store,
      publicUrl: ctx.publicUrl,
      clock: ctx.clock,
    };
    const schedules = new Schedules(d.db, d.events, d.settings, d.tasks, d.clock);
    const triggers = new Triggers(
      d.db,
      d.events,
      d.settings,
      d.tasks,
      d.notifier,
      d.publicUrl,
      d.clock,
    );
    const watchers = new Watchers(d);
    const heartbeat = new Heartbeat(d);
    const report = new WeeklyReport(d);

    // A deleted bot's automations, and a heartbeat that ran as it, go to Hatbot switched off.
    const unlisten = d.events.on((e) => {
      if (e.type !== "bot.deleted") return;
      const moved = moveFrom(d.db, e.id);
      const { heartbeat: beat } = d.settings.get();
      if (beat.botId === e.id)
        d.settings.update({ heartbeat: { ...beat, enabled: false, botId: HATBOT_ID } });
      for (const id of moved.schedules) {
        const schedule = schedules.get(id);
        if (schedule) d.events.emit({ type: "schedule.updated", schedule });
      }
      for (const id of moved.triggers) {
        const trigger = triggers.get(id);
        if (trigger) d.events.emit({ type: "trigger.updated", trigger });
      }
      for (const id of moved.watchers) {
        const watcher = watchers.get(id);
        if (watcher) d.events.emit({ type: "watcher.updated", watcher });
      }
    });

    return ready(automationTools({ schedules, triggers, watchers, ...d }), {
      services: { schedules, triggers, watchers, heartbeat, report },
      routes: routes({ schedules, triggers, watchers, heartbeat, report, ...d }),
      ticks: [
        { name: "schedules", everyMs: 10_000, run: () => schedules.tick() },
        { name: "triggers", everyMs: 10_000, run: () => triggers.tick() },
        { name: "watchers", everyMs: 10_000, run: () => watchers.tick() },
        { name: "heartbeat", everyMs: 10_000, run: () => heartbeat.tick() },
        { name: "weekly report", everyMs: 10_000, run: () => report.tick() },
      ],
      origins: {
        schedule: schedules.origin(),
        watch: watchers.origin(),
        heartbeat: HEARTBEAT_ORIGIN,
        ...triggers.origins(),
      },
      search: (query) => {
        const pattern = like(query);
        return [
          ...schedules.search(pattern),
          ...triggers.search(pattern),
          ...watchers.search(pattern),
        ];
      },
      checks: [
        { id: "schedules", name: "Schedules", run: async () => schedulesCheck(d) },
        { id: "watchers", name: "Watchers", run: async () => watchersCheck(d) },
      ],
      prompt: {
        chat: `- The tools for schedules, watchers and triggers load when you need them: find them with tool_search_tool_regex (a pattern like "automation_schedule" or "automation_watch").
- When the owner wants something done later or regularly ("every morning at 8, check X"), create a schedule. Each run is a background task that can't see this chat, so its prompt must say everything: what to do, what counts as news, and when to tell the owner. It can name a skill.
- Webhooks and Uptime Kuma alerts are triggers the owner sets up in the app. You can see and adjust them, but not create them.`,
      },
      stop: unlisten,
    });
  },
});

function schedulesCheck(d: Deps) {
  // Each schedule's last three runs; three failures in a row mean it's broken.
  const rows = d.db
    .query<{ name: string; failed: number; runs: number }, []>(
      `SELECT s.name, sum(t.status = 'failed') AS failed, count(*) AS runs FROM schedules s
       JOIN tasks t ON t.id IN (SELECT id FROM tasks WHERE schedule_id = s.id AND parent_id IS NULL ORDER BY id DESC LIMIT 3)
       WHERE s.enabled = 1 GROUP BY s.id`,
    )
    .all();
  const broken = rows.filter((r) => r.runs === 3 && r.failed === 3).map((r) => `"${r.name}"`);
  const count =
    d.db.query<{ n: number }, []>("SELECT count(*) AS n FROM schedules WHERE enabled = 1").get()
      ?.n ?? 0;
  if (broken.length)
    return {
      state: "warn" as const,
      detail: `Failed its last three runs: ${broken.join(", ")}. Open it in Schedules.`,
    };
  return { state: "ok" as const, detail: count ? `${count} on, none failing.` : "None yet." };
}

function watchersCheck(d: Deps) {
  const rows = d.db
    .query<{ name: string; errors: number }, []>(
      "SELECT name, errors FROM watchers WHERE enabled = 1",
    )
    .all();
  const failing = rows.filter((r) => r.errors > 0).map((r) => `"${r.name}"`);
  if (failing.length)
    return {
      state: "warn" as const,
      detail: `Can't read ${failing.join(", ")} right now. Open it in Schedules.`,
    };
  return {
    state: "ok" as const,
    detail: rows.length ? `${rows.length} on, all reading.` : "None yet.",
  };
}
