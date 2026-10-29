import type { DesktopAgent } from "@hatbot/plugin-desktop";
import type {
  BotsHost,
  ChatsHost,
  Db,
  EventsHost,
  ModelHost,
  Notifier,
  PluginsHost,
  PluginVault,
  SettingsHost,
  SpendHost,
  TasksHost,
} from "@hatbot/plugin-sdk";
import type { T3Code } from "@hatbot/plugin-t3/client";

/** What boxes reach in the core and other plugins. */
export type Deps = {
  db: Db;
  events: EventsHost;
  settings: SettingsHost;
  spend: SpendHost;
  model: ModelHost;
  chats: ChatsHost;
  bots: BotsHost;
  tasks: TasksHost;
  notifier: Notifier;
  plugins: PluginsHost;
  vault: PluginVault;
  publicUrl: string;
  clock: () => number;
  /** Null while there's none. */
  desktop: () => DesktopAgent | null;
  t3: () => T3Code | null;
};
