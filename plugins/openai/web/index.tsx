import { IdListSettings, type PluginSettingsProps, type PluginWeb } from "@hatbot/web/kit";

const MODEL = /^[\w.:/@-]{1,200}$/;

export function OpenAISettings(props: PluginSettingsProps<{ models: string[] }>) {
  return (
    <IdListSettings
      {...props}
      field="models"
      title="Models"
      label="The models to offer in Settings; none: every one it lists that can use tools"
      placeholder="e.g. openai/gpt-4o, google/gemini-2.5-pro"
      parse={(s) => s}
      valid={(id) => MODEL.test(id)}
      invalid="Model ids look like openai/gpt-4o: no spaces."
    />
  );
}

export const web: PluginWeb = { settings: OpenAISettings };
