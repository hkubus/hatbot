// Each plugin's settings form in Settings (PLAN.md §4.5), by plugin id. A plugin without one only has
// its switch, secrets and Test button.
import type { ComponentType } from "react";
import { ProxmoxSettings } from "./proxmox";
import { SshSettings } from "./ssh";

export type PluginSettingsProps<C = unknown> = {
  config: C;
  /** Saves new settings; the plugin restarts with them. Rejects with the brain's message. */
  save: (config: C) => Promise<void>;
  /** One of the plugin's actions. Rejects with the brain's message. */
  action: <T = unknown>(name: string, args?: unknown) => Promise<T>;
  /** The plugin is running with its current settings. */
  ready: boolean;
};

export const PLUGIN_SETTINGS: Record<string, ComponentType<PluginSettingsProps>> = {
  proxmox: ProxmoxSettings as ComponentType<PluginSettingsProps>,
  ssh: SshSettings as ComponentType<PluginSettingsProps>,
};
