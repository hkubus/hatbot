// Every plugin that ships with Hatbot (PLAN.md §4.5). You switch them on in Settings.
import { forgejoPlugin } from "./forgejo";
import { homeassistantPlugin } from "./homeassistant";
import { mcpPlugin } from "./mcp";
import { pbsPlugin } from "./pbs";
import type { Plugin } from "./plugin";
import { proxmoxPlugin } from "./proxmox";
import { sshPlugin } from "./ssh";
import { uptimeKumaPlugin } from "./uptimekuma";

export const PLUGINS: Plugin[] = [
  proxmoxPlugin,
  pbsPlugin,
  sshPlugin,
  homeassistantPlugin,
  uptimeKumaPlugin,
  forgejoPlugin,
  mcpPlugin,
];
