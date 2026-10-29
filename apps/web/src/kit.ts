// What a plugin's web entry builds its pages from, so it looks and behaves like the rest.
import type { ComponentType } from "react";

export { useAction } from "./action";
export { api, errorText } from "./api";
export { ask, askText, useLeaveGuard } from "./confirm";
export { Copyable } from "./copy";
export { IdListSettings } from "./plugin-kit/id-list";
export { useSignInReturn } from "./plugin-kit/sign-in";
export { navigate, useRoute } from "./router";
export { Switch } from "./switch";
export { Disclosure, Group, LinkRow, Panel, Row, SaveBar, Seg, Select } from "./ui";

export type PluginSettingsProps<C = unknown> = {
  config: C;
  /** The plugin restarts with them, and turnOn switches it on. Rejects with the brain's message. */
  save: (config: C, turnOn?: boolean) => Promise<void>;
  action: <T = unknown>(name: string, args?: unknown) => Promise<T>;
  /** The plugin is running (on, or waiting for setup), so its actions answer. */
  running: boolean;
};

/** A plugin's `/web` entry exports one as `web`. */
export type PluginWeb = {
  /** Its own part of its Settings page; without one there's only its switch, environment and Test. */
  // biome-ignore lint/suspicious/noExplicitAny: each plugin's form takes its own config
  settings?: ComponentType<PluginSettingsProps<any>>;
  /** A row in Automations' built-in group. */
  builtIn?: ComponentType<Pick<PluginSettingsProps, "action" | "running">>;
};
