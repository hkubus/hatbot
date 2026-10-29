// Your own Linux computers, through Hatbot's Linux app: its agent dials in, and desktop tasks use their
// screens, as you, alongside the desktop. Only the computer turns its use on.

import { definePlugin, type EventsHost, ready } from "@hatbot/plugin-sdk";
import { ACTIVE_TASK_STATUSES, type ComputerInfo } from "@hatbot/shared";
import { z } from "zod";
import { Computers } from "./computers";
import { routes } from "./routes";
import { computerTools, grantKey } from "./tools";

export { BLOCKED_TEXT, type Blocked, type ComputerScreen, Computers } from "./computers";
export { ComputerError } from "./link";
export { grantKey };

/** What the plugin gives others as "computers". */
export type ComputersService = Pick<Computers, "list" | "find" | "screen" | "screens">;

const lines = (list: ComputerInfo[], place: "chat" | "task") => {
  const names = list.map((c) => `${c.name}${c.online ? "" : " (offline)"}`).join(", ");
  const run =
    place === "chat"
      ? "run_desktop_task works on your desktop unless you pass screen with one of their names"
      : "Pass screen with one of their names to run_desktop_task to work on it instead of your desktop";
  return `- The owner's own computers: ${names}. ${run}: only when the owner names that computer, or the work needs their own logins, apps or files there. Each use asks the owner first. computer_exec, computer_get_file and computer_put_file reach them directly, as the owner, never with sudo.`;
};

export const computerPlugin = definePlugin({
  id: "computer",
  name: "Your computers",
  description:
    "Hatbot uses your own Linux computers through Hatbot's Linux app: their screens for desktop tasks, and their files and commands as you. Each computer turns this on itself.",
  config: z.object({}),
  defaultOn: true,
  allBots: true,
  needs: ["events"],
  provides: ["computers"],
  migrations: [
    `CREATE TABLE computer_machines (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      careful INTEGER NOT NULL DEFAULT 0,
      token_id INTEGER,
      last_seen_at TEXT
    );`,
  ],
  tables: ["computer_machines"],
  routes: ["/computers"],
  sockets: ["/computer/connect", "/computer/live/:id"],
  start: (ctx) => {
    const events = ctx.service<EventsHost>("events");
    const computers = new Computers(ctx.db, events, ctx.clock);
    const unlisten = events.on((e) => {
      if (e.type === "task.updated" && !ACTIVE_TASK_STATUSES.includes(e.task.status))
        computers.forgetGrants(grantKey({ task: { id: e.task.id, tainted: false } }));
    });
    const service: ComputersService = computers;
    const id = (args: unknown) => z.object({ id: z.string() }).parse(args).id;
    return ready(computerTools(computers, ctx.files), {
      services: { computers: service },
      routes: routes(computers),
      get prompt() {
        const list = computers.list();
        return list.length ? { chat: lines(list, "chat"), task: lines(list, "task") } : {};
      },
      actions: {
        list: async () => computers.list(),
        rename: async (args) => {
          const { name } = z.object({ name: z.string().trim().min(1).max(60) }).parse(args);
          computers.rename(id(args), name);
          return computers.list();
        },
        careful: async (args) => {
          computers.setCareful(id(args), z.object({ careful: z.boolean() }).parse(args).careful);
          return computers.list();
        },
        pause: async (args) => {
          await computers.pause(id(args), z.object({ paused: z.boolean() }).parse(args).paused);
          return computers.list();
        },
        turnOff: async (args) => {
          await computers.turnOff(id(args));
          return computers.list();
        },
        forget: async (args) => {
          computers.forget(id(args));
          return computers.list();
        },
      },
      stop: () => {
        unlisten();
        for (const c of computers.list()) computers.linkOf(c.id)?.close(1012, "Restarting");
      },
    });
  },
});
