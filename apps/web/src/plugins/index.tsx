// A plugin without a form here only has its switch, environment and Test button.
import type { ComponentType } from "react";
import { HomeAssistantSettings } from "./homeassistant";
import { McpSettings } from "./mcp";
import { ProxmoxSettings } from "./proxmox";
import { SelfSettings } from "./self";
import { SshSettings } from "./ssh";
import { T3Settings } from "./t3";

export type PluginSettingsProps<C = unknown> = {
  config: C;
  /** The plugin restarts with them. Rejects with the brain's message. */
  save: (config: C) => Promise<void>;
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
  t3: T3Settings as ComponentType<PluginSettingsProps>,
};
