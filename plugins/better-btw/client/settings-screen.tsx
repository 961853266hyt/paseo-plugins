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
import { SAME_AS_AGENT, sideQuestionSettings } from "../shared/settings";

type ReadySettings = Extract<SettingsState<typeof sideQuestionSettings.schema>, { status: "ready" }>;

interface Option {
  label: string;
  value: string;
}

// Claude Code aliases, so each follows the newest model of its family.
const fixedModels: Option[] = [
  { label: "Same as the agent", value: SAME_AS_AGENT },
  { label: "Latest Haiku", value: "haiku" },
  { label: "Latest Sonnet", value: "sonnet" },
  { label: "Latest Opus", value: "opus" },
];

/**
 * The fixed choices, then the Claude models Paseo offers its own agents. Only the fixed choices
 * until that list loads, and if it fails.
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
          // 1M-context variants cost more past 200K tokens, which a side question never reaches.
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
  return useMemo(() => [...fixedModels, ...models], [models]);
}

export function SideQuestionSettingsScreen({ theme }: PluginSurfaceProps) {
  const settings = useSettings(sideQuestionSettings);
  const style = useMemo(() => ({ color: theme.colors.foreground }), [theme]);
  if (settings.status === "loading") return <Text style={style}>Loading settings…</Text>;
  if (settings.status !== "ready") {
    return (
      <SettingsSection title="Better btw">
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
  const changeModel = useCallback(
    (model: string) => {
      void settings.save({ ...settings.values, model }, settings.revision);
    },
    [settings],
  );
  return (
    <SettingsSection title="Better btw">
      <SettingsCard>
        <SettingsSelect
          label="Model"
          hint="Same as the agent answers with a Claude agent's own model, as Claude Code does, and with Latest Sonnet for other agents. Every side question sends the agent's conversation to Anthropic through Claude Code."
          value={settings.values.model}
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
