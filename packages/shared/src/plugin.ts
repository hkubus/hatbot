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
  /** What it reads from /etc/hatbot/*.env on the brain, each of which can be set here instead. */
  env: PluginEnvInfo[];
  /** Secrets set here by any name, for a plugin that takes them (MCP's ${NAME}); null otherwise. */
  named: string[] | null;
  /** Its settings, in the plugin's own shape. */
  config: unknown;
  tools: { name: string; access: "read" | "write"; description: string }[];
  /** It has a Test button. */
  testable: boolean;
};

export type PluginEnvInfo = {
  name: string;
  /** Only ever sent: the app is told whether it's set, never what to. */
  secret: boolean;
  optional: boolean;
  /** What goes in it, for the empty field. */
  hint: string | null;
  set: boolean;
  /** Set in Settings, or in the host's env file. */
  from: "app" | "host" | null;
  /** Its value, when it isn't secret. */
  value: string | null;
};

/** Each is set here, or null to forget the value set here and use the host's again. */
export const SetPluginSecrets = z.object({
  values: z.record(
    z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/, "A name like HA_TOKEN: capitals, digits and _."),
    z
      .string()
      .trim()
      .min(1, "Leave it out instead.")
      .max(8192)
      .regex(/^[^\r\n]*$/, "One line.")
      .nullable(),
  ),
});
export type SetPluginSecrets = z.infer<typeof SetPluginSecrets>;

export const UpdatePlugin = z.object({
  enabled: z.boolean().optional(),
  config: z.unknown().optional(),
});
