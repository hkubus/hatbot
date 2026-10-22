import { forgejoPlugin } from "./forgejo";
import { githubPlugin } from "./github";
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
  githubPlugin,
  mcpPlugin,
];
