// Every plugin that ships with Hatbot (PLAN.md §4.5). You switch them on in Settings.
import type { Plugin } from "./plugin";
import { proxmoxPlugin } from "./proxmox";

export const PLUGINS: Plugin[] = [proxmoxPlugin];
