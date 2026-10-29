import { forgejoPlugin } from "@hatbot/plugin-forgejo";
import { githubPlugin } from "@hatbot/plugin-github";
import { homeassistantPlugin } from "@hatbot/plugin-homeassistant";
import { mcpPlugin } from "@hatbot/plugin-mcp";
import { pbsPlugin } from "@hatbot/plugin-pbs";
import { proxmoxPlugin } from "@hatbot/plugin-proxmox";
import type { Plugin } from "@hatbot/plugin-sdk";
import { sshPlugin } from "@hatbot/plugin-ssh";
import { uptimeKumaPlugin } from "@hatbot/plugin-uptimekuma";

export const PLUGINS: Plugin[] = [
  proxmoxPlugin,
  pbsPlugin,
  sshPlugin,
  homeassistantPlugin,
  uptimeKumaPlugin,
  forgejoPlugin,
  githubPlugin,
  mcpPlugin,
];
