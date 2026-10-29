// The desktop container: Chromium on a screen the bots drive and you can take over, and a shell user,
// the sandbox, for scratch work. desktop-agent on it does what the brain asks.

import {
  definePlugin,
  type EventsHost,
  ready,
  type Sandbox,
  type SettingsHost,
} from "@hatbot/plugin-sdk";
import { z } from "zod";
import { desktopChecks } from "./checks";
import { type DesktopAgent, HttpDesktopAgent } from "./client";
import { Desktop } from "./control";
import { ScreenLane } from "./lane";
import { Live, routes } from "./routes";

export {
  actionTimeoutMs,
  browserTimeoutMs,
  type DesktopAgent,
  DesktopError,
  HttpDesktopAgent,
} from "./client";
export { Desktop, DesktopBusy } from "./control";
export { ScreenLane } from "./lane";
export { frameRelay, Live } from "./routes";

/** What the desktop plugin gives others as "desktop"; the sandbox alone is "sandbox". */
export type DesktopService = {
  agent: DesktopAgent;
  control: Desktop;
  /** One task on the screen at a time. */
  lane: ScreenLane;
  live: Live;
};

/** `agent` stands in for desktop-agent, in tests. */
export const desktopPlugin = (agent?: DesktopAgent) =>
  definePlugin({
    id: "desktop",
    name: "Desktop",
    description:
      "A Linux desktop with Chromium for what needs a real browser, which you can watch and take over, and a sandbox for scratch work.",
    config: z.object({}),
    defaultOn: true,
    allBots: true,
    env: [
      { name: "DESKTOP_AGENT_URL", optional: true, hint: "http://192.168.55.111:8080" },
      { name: "DESKTOP_AGENT_TOKEN", secret: true, optional: true },
    ],
    needs: ["events", "settings"],
    provides: ["desktop", "sandbox"],
    routes: ["/desktop/status", "/desktop/takeover", "/desktop/handback"],
    sockets: ["/desktop/live"],
    start: async (ctx) => {
      const events = ctx.service<EventsHost>("events");
      const settings = ctx.service<SettingsHost>("settings");
      const desk =
        agent ??
        new HttpDesktopAgent(ctx.env.DESKTOP_AGENT_URL ?? "", ctx.env.DESKTOP_AGENT_TOKEN ?? "");
      const control = new Desktop(desk, events, ctx.store);
      const live = new Live();
      const service: DesktopService = { agent: desk, control, lane: new ScreenLane(), live };
      const unlisten = events.on((e) => {
        if (e.type === "paused") void control.setPaused(e.paused);
      });
      await control.setPaused(settings.get().paused);
      await control.refresh();
      return ready([], {
        services: { desktop: service, sandbox: desk satisfies Sandbox },
        routes: routes(desk, control, live),
        ticks: [{ name: "desktop", everyMs: 30_000, run: () => control.refresh() }],
        signals: async () =>
          desk.configured && !control.get().online
            ? [{ key: "desktop", text: "The desktop isn't answering." }]
            : [],
        get checks() {
          return desktopChecks(desk, ctx.release());
        },
        stop: unlisten,
      });
    },
  });
