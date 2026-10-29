// The web entries of the plugins that have one.
import { web as homeassistant } from "@hatbot/plugin-homeassistant/web";
import { web as mcp } from "@hatbot/plugin-mcp/web";
import { web as proxmox } from "@hatbot/plugin-proxmox/web";
import { web as scout } from "@hatbot/plugin-scout/web";
import { web as self } from "@hatbot/plugin-self/web";
import { web as ssh } from "@hatbot/plugin-ssh/web";
import { web as t3 } from "@hatbot/plugin-t3/web";
import type { PluginWeb } from "./kit";

export const PLUGIN_WEB: Record<string, PluginWeb> = {
  homeassistant,
  mcp,
  proxmox,
  scout,
  self,
  ssh,
  t3,
};
