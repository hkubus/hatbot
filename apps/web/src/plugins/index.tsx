// Each plugin's settings form in Settings (PLAN.md §4.5), by plugin id. A plugin without one only has
// its switch, environment and Test button.
import type { ComponentType } from "react";
import { HomeAssistantSettings } from "./homeassistant";
import { McpSettings } from "./mcp";
import { ProxmoxSettings } from "./proxmox";
import { SelfSettings } from "./self";
import { SshSettings } from "./ssh";

export type PluginSettingsProps<C = unknown> = {
  config: C;
  /** Saves new settings; the plugin restarts with them. Rejects with the brain's message. */
  save: (config: C) => Promise<void>;
  /** One of the plugin's actions. Rejects with the brain's message. */
  action: <T = unknown>(name: string, args?: unknown) => Promise<T>;
  /** The plugin is running (on, or waiting for setup), so its actions answer. */
  running: boolean;
};

export const PLUGIN_SETTINGS: Record<string, ComponentType<PluginSettingsProps>> = {
  proxmox: ProxmoxSettings as ComponentType<PluginSettingsProps>,
  ssh: SshSettings as ComponentType<PluginSettingsProps>,
  mcp: McpSettings as ComponentType<PluginSettingsProps>,
  homeassistant: HomeAssistantSettings as ComponentType<PluginSettingsProps>,
  self: SelfSettings,
};
