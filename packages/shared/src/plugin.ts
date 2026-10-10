// Plugins (PLAN.md §4.5): what Settings shows and changes.
import { z } from "zod";

export type PluginState = "off" | "starting" | "ready" | "needs_setup" | "error";

export type PluginInfo = {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  state: PluginState;
  /** What to do when it needs setup, or what went wrong. */
  message: string | null;
  /** Environment variables it reads from /etc/hatbot/*.env, and whether each is set. */
  secrets: { name: string; set: boolean }[];
  /** Its settings, in the plugin's own shape. */
  config: unknown;
  tools: { name: string; access: "read" | "write"; description: string }[];
  /** It has a Test button. */
  testable: boolean;
};

export const UpdatePlugin = z.object({
  enabled: z.boolean().optional(),
  config: z.unknown().optional(),
});
