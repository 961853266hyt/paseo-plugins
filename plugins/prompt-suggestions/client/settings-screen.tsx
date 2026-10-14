import { type PluginSurfaceProps, type SettingsState, useSettings } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsSection,
} from "@getpaseo/plugin/client/ui";
import { useCallback, useMemo, useState } from "react";
import { Text } from "react-native";
import { parseProviders, suggestionSettings } from "../shared/settings";

type ReadySettings = Extract<SettingsState<typeof suggestionSettings.schema>, { status: "ready" }>;

export function SuggestionSettingsScreen({ theme }: PluginSurfaceProps) {
  const settings = useSettings(suggestionSettings);
  const style = useMemo(() => ({ color: theme.colors.foreground }), [theme]);
  if (settings.status === "loading") return <Text style={style}>Loading settings…</Text>;
  if (settings.status !== "ready") {
    return (
      <SettingsSection title="Prompt suggestions">
        <Text style={style}>{settings.error}</Text>
        <SettingsAction label="Try again" actionLabel="Reload" onPress={settings.reload} />
        {settings.status === "invalid" ? (
          <SettingsAction
            label="Restore default settings"
            actionLabel="Reset"
            onPress={settings.reset}
          />
        ) : null}
      </SettingsSection>
    );
  }
  // A new revision, saved here or on another client, starts a fresh draft from the saved values.
  return <SettingsForm key={settings.revision} settings={settings} />;
}

function SettingsForm({ settings }: { settings: ReadySettings }) {
  // Saved against the revision the draft started from, so another client's save is not overwritten.
  const [revision] = useState(settings.revision);
  const [providers, setProviders] = useState(settings.values.providers.join(", "));
  const [model, setModel] = useState(settings.values.model);
  const save = useCallback(() => {
    void settings.save({ providers: parseProviders(providers), model }, revision);
  }, [settings, providers, model, revision]);
  return (
    <SettingsSection title="Prompt suggestions">
      <SettingsCard>
        <SettingsInput
          label="Agent providers"
          hint="Provider IDs such as claude, codex or opencode, separated by commas. Leave empty to suggest for every agent."
          initialValue={providers}
          placeholder="Every agent"
          onChangeText={setProviders}
          disabled={settings.saving}
        />
        <SettingsInput
          label="Model"
          hint="Passed to claude --model: an alias such as haiku or sonnet, or a full model name."
          initialValue={model}
          onChangeText={setModel}
          disabled={settings.saving}
        />
        <SettingsAction
          label="Apply to the next suggestion"
          actionLabel="Save"
          error={settings.saveError}
          disabled={settings.saving}
          onPress={save}
        />
      </SettingsCard>
    </SettingsSection>
  );
}
