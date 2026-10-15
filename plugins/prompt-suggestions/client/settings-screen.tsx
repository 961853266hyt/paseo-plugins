import {
  type PluginSurfaceProps,
  type SettingsState,
  usePaseo,
  useSettings,
} from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsSection,
  SettingsSelect,
} from "@getpaseo/plugin/client/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Text } from "react-native";
import { suggestionSettings } from "../shared/settings";

type ReadySettings = Extract<SettingsState<typeof suggestionSettings.schema>, { status: "ready" }>;

interface Option {
  label: string;
  value: string;
}

const EVERY_AGENT = "every";

// Other values are provider IDs; every agent is stored as an empty list.
const agentOptions: Option[] = [
  { label: "All agents", value: EVERY_AGENT },
  { label: "Claude agents only", value: "claude" },
];

// Claude Code aliases, so each follows the newest model of its family.
const latestModels: Option[] = [
  { label: "Latest Haiku", value: "haiku" },
  { label: "Latest Sonnet", value: "sonnet" },
  { label: "Latest Opus", value: "opus" },
];

/**
 * The aliases, then the Claude models Paseo offers its own agents. Only the aliases until that list
 * loads, and if it fails.
 */
function useModelOptions(): Option[] {
  const paseo = usePaseo();
  const [models, setModels] = useState<Option[]>([]);
  useEffect(() => {
    let active = true;
    paseo.providers.listModels("claude").then(
      (result) => {
        if (!active) return;
        const listed = (result.models ?? []).filter(
          // 1M-context variants cost more and gain nothing on a short transcript.
          (model) => model.isSelectable !== false && !model.id.endsWith("[1m]"),
        );
        setModels(listed.map((model) => ({ label: model.label, value: model.id })));
      },
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [paseo]);
  return useMemo(() => [...latestModels, ...models], [models]);
}

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
  return <SettingsForm settings={settings} style={style} />;
}

function SettingsForm({ settings, style }: { settings: ReadySettings; style: { color: string } }) {
  const modelOptions = useModelOptions();
  const changeAgents = useCallback(
    (agents: string) => {
      const providers = agents === EVERY_AGENT ? [] : [agents];
      void settings.save({ ...settings.values, providers }, settings.revision);
    },
    [settings],
  );
  const changeModel = useCallback(
    (model: string) => {
      void settings.save({ ...settings.values, model }, settings.revision);
    },
    [settings],
  );
  const { providers, model } = settings.values;
  return (
    <SettingsSection title="Prompt suggestions">
      <SettingsCard>
        <SettingsSelect
          label="Suggest for"
          hint="Each prediction sends the recent conversation to Anthropic. Choose Claude agents only to keep conversations with other agents off it."
          // A list saved by an earlier build shows as is until another option is chosen.
          value={providers.length === 0 ? EVERY_AGENT : providers.join(", ")}
          options={agentOptions}
          disabled={settings.saving}
          onValueChange={changeAgents}
        />
        <SettingsSelect
          label="Model"
          hint="Latest follows the newest model of each family. Haiku is the fastest; larger models predict more slowly and use more of your Claude usage."
          value={model}
          options={modelOptions}
          disabled={settings.saving}
          onValueChange={changeModel}
        />
      </SettingsCard>
      {settings.saveError ? (
        <Text accessibilityRole="alert" style={style}>
          {settings.saveError}
        </Text>
      ) : null}
    </SettingsSection>
  );
}
