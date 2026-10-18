// Home Assistant's settings: entities that let someone in besides locks, alarms and covers, such as
// a gate on a switch, or a script or an integration's scene that opens one. Every change to them
// always asks first.
import type { PluginSettingsProps } from ".";
import { IdListSettings } from "./id-list";

const ENTITY = /^[a-z0-9_]+\.[a-z0-9_]+$/;

export function HomeAssistantSettings(props: PluginSettingsProps<{ access: string[] }>) {
  return (
    <IdListSettings
      {...props}
      field="access"
      label="Always ask before changing these entities, such as scripts or scenes that open a door"
      placeholder="e.g. switch.gate, script.open_garage"
      // Home Assistant reads ids in any case as lowercase.
      parse={(s) => s.toLowerCase()}
      valid={(id) => ENTITY.test(id)}
      invalid="Entity ids look like switch.gate: letters, digits and _, with a dot."
    />
  );
}
