// Every plugin that ships with Hatbot (PLAN.md §4.5). You switch them on in Settings.
import { forgejoPlugin } from "./forgejo";
import { mcpPlugin } from "./mcp";
import type { Plugin } from "./plugin";
import { proxmoxPlugin } from "./proxmox";
import { sshPlugin } from "./ssh";

export const PLUGINS: Plugin[] = [proxmoxPlugin, sshPlugin, forgejoPlugin, mcpPlugin];
