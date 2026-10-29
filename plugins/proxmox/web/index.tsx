import { IdListSettings, type PluginSettingsProps, type PluginWeb } from "@hatbot/web/kit";

export function ProxmoxSettings(props: PluginSettingsProps<{ careful: number[] }>) {
  return (
    <IdListSettings
      {...props}
      field="careful"
      title="Guests"
      label="Always ask before powering or changing these guests"
      placeholder="e.g. 100, 200"
      parse={Number}
      valid={(n) => Number.isInteger(n) && n > 0}
      invalid="Guest IDs are whole numbers, like 105."
    />
  );
}

export const web: PluginWeb = { settings: ProxmoxSettings };
