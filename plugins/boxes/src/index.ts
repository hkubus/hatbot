// Boxes: small web apps a bot makes, kept and opened from the chat. The brain serves their pages
// sandboxed; their backends build and run on the boxes guest.
import type { DesktopService } from "@hatbot/plugin-desktop";
import {
  type BotsHost,
  type ChatsHost,
  definePlugin,
  type EventsHost,
  type ModelHost,
  type Notifier,
  type PluginsHost,
  ready,
  type SettingsHost,
  type SpendHost,
  type TasksHost,
} from "@hatbot/plugin-sdk";
import type { T3Code } from "@hatbot/plugin-t3/client";
import { z } from "zod";
import { Backends } from "./backends";
import { Boxes } from "./boxes";
import { type HatboxAgent, HttpHatboxAgent } from "./client";
import type { Deps } from "./deps";
import { BoxFeeds } from "./feeds";
import { routes } from "./routes";
import { boxJob } from "./t3-job";
import { boxTools } from "./tools";

export { Backends, BOX_CRON_GAP_MS, NO_GUEST } from "./backends";
export { BoxError, Boxes, FRAME_CSP, NOTIFY_PER_DAY, previewed } from "./boxes";
export { type BoxRequest, type HatboxAgent, HatboxError, HttpHatboxAgent } from "./client";
export { BoxFeeds, MAX_BOX_FEEDS } from "./feeds";

const CHAT = `- The tools for boxes load when you need them: find them with tool_search_tool_regex (a pattern like "boxes_"), then call them.
- When the owner wants a tool to keep and come back to (a tracker, a calculator, a planner, a page of numbers they update), make a box with boxes_create: a small web app they open from the chat, which keeps its own data. Change it with boxes_edit when they ask for changes; boxes_list shows the ones you made. A one-off answer stays in your reply.
- A box that needs data from the web or work on a schedule gets files with a backend (server.ts) and the hosts it may reach in box.json. Try its backend with boxes_call, and read boxes_logs when it misbehaves.`;

/** `agent` stands in for the boxes guest, in tests. */
export const boxesPlugin = (agent?: HatboxAgent) =>
  definePlugin({
    id: "boxes",
    name: "Boxes",
    description:
      "Small web apps a bot makes for you, kept and opened from the chat, with backends on the boxes guest.",
    config: z.object({}),
    defaultOn: true,
    allBots: true,
    env: [
      { name: "HATBOX_AGENT_URL", optional: true, hint: "http://192.168.55.111:8090" },
      { name: "HATBOX_AGENT_TOKEN", secret: true, optional: true },
    ],
    needs: [
      "tasks",
      "chats",
      "bots",
      "notifier",
      "events",
      "settings",
      "model",
      "spend",
      "plugins",
    ],
    uses: ["desktop", "t3"],
    provides: ["boxes"],
    routes: ["/boxes"],
    publicRoutes: ["/boxes/:id/frame"],
    start: (ctx) => {
      const d: Deps = {
        db: ctx.db,
        events: ctx.service<EventsHost>("events"),
        settings: ctx.service<SettingsHost>("settings"),
        spend: ctx.service<SpendHost>("spend"),
        model: ctx.service<ModelHost>("model"),
        chats: ctx.service<ChatsHost>("chats"),
        bots: ctx.service<BotsHost>("bots"),
        tasks: ctx.service<TasksHost>("tasks"),
        notifier: ctx.service<Notifier>("notifier"),
        plugins: ctx.service<PluginsHost>("plugins"),
        vault: ctx.vault,
        publicUrl: ctx.publicUrl,
        clock: ctx.clock,
        desktop: () => ctx.optional<DesktopService>("desktop")?.agent ?? null,
        t3: () => ctx.optional<T3Code>("t3"),
      };
      const boxes = new Boxes(d);
      const guest =
        agent ??
        new HttpHatboxAgent(
          ctx.env.HATBOX_AGENT_URL ?? "",
          ctx.env.HATBOX_AGENT_TOKEN ?? "",
          ctx.fetch,
        );
      boxes.backends = new Backends(boxes, guest, d.settings, d.clock);
      boxes.feeds = new BoxFeeds(d);
      const backends = boxes.backends;
      const feeds = boxes.feeds;

      const unlisten = d.events.on((e) => {
        // A deleted bot's boxes go to Hatbot.
        if (e.type === "bot.deleted") boxes.orphan(e.id);
        // They start again on a request once Hatbot is resumed.
        if (e.type === "paused" && e.paused) void backends.stopAll();
      });

      return ready(boxTools(d, boxes), {
        services: { boxes },
        routes: routes(boxes),
        jobs: { box: boxJob(d, boxes) },
        ticks: [
          { name: "backends", everyMs: 10_000, run: () => backends.tick() },
          { name: "feeds", everyMs: 10_000, run: () => feeds.tick() },
        ],
        prompt: { chat: CHAT },
        stop: unlisten,
      });
    },
  });
