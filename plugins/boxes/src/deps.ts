import type { DesktopAgent } from "@hatbot/plugin-desktop";
import type { Db, Hosts, PluginVault } from "@hatbot/plugin-sdk";
import type { T3Code } from "@hatbot/plugin-t3/client";

/** What boxes reach in the core and other plugins. */
export const NEEDS = [
  "tasks",
  "chats",
  "bots",
  "notifier",
  "events",
  "settings",
  "model",
  "spend",
  "plugins",
] satisfies (keyof Hosts)[];

/** What boxes reach in the core and other plugins. */
export type Deps = Pick<Hosts, (typeof NEEDS)[number]> & {
  db: Db;
  vault: PluginVault;
  publicUrl: string;
  clock: () => number;
  /** Null while there's none. */
  desktop: () => DesktopAgent | null;
  t3: () => T3Code | null;
};
