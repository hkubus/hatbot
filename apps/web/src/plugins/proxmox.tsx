// Proxmox's settings: guests where every change asks first (power, and commands and files over SSH).
import type { PluginSettingsProps } from ".";
import { IdListSettings } from "./id-list";

export function ProxmoxSettings(props: PluginSettingsProps<{ careful: number[] }>) {
  return (
    <IdListSettings
      {...props}
      field="careful"
      label="Always ask before powering or changing these guests"
      placeholder="e.g. 100, 200"
      parse={Number}
      valid={(n) => Number.isInteger(n) && n > 0}
      invalid="Guest IDs are whole numbers, like 105."
    />
  );
}
