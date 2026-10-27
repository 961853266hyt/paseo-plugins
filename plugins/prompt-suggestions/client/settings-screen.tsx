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
import { type TextKey, useText } from "./i18n";

type ReadySettings = Extract<SettingsState<typeof suggestionSettings.schema>, { status: "ready" }>;

interface Option {
  label: string;
  value: string;
}

interface TextOption {
  label: TextKey;
  value: string;
}

const EVERY_AGENT = "every";

// Other values are provider IDs; every agent is stored as an empty list.
const agentOptions: TextOption[] = [
  { label: "settings.allAgents", value: EVERY_AGENT },
  { label: "settings.claudeOnly", value: "claude" },
];

// Claude Code aliases, so each follows the newest model of its family.
const latestModels: TextOption[] = [
  { label: "settings.latestHaiku", value: "haiku" },
  { label: "settings.latestSonnet", value: "sonnet" },
  { label: "settings.latestOpus", value: "opus" },
];

/**
 * The aliases, then the Claude models Paseo offers its own agents. Only the aliases until that list
 * loads, and if it fails.
 */
function useModelOptions(): Option[] {
  const paseo = usePaseo();
  const t = useText();
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
  return useMemo(
    () => [...latestModels.map((option) => ({ ...option, label: t(option.label) })), ...models],
    [models, t],
  );
}

export function SuggestionSettingsScreen({ theme }: PluginSurfaceProps) {
  const settings = useSettings(suggestionSettings);
  const t = useText();
  const style = useMemo(() => ({ color: theme.colors.foreground }), [theme]);
  if (settings.status === "loading") return <Text style={style}>{t("settings.loading")}</Text>;
  if (settings.status !== "ready") {
    return (
      <SettingsSection title={t("settings.section")}>
        <Text style={style}>{settings.error}</Text>
        <SettingsAction
          label={t("settings.tryAgain")}
          actionLabel={t("settings.reload")}
          onPress={settings.reload}
        />
        {settings.status === "invalid" ? (
          <SettingsAction
            label={t("settings.restoreDefaults")}
            actionLabel={t("settings.reset")}
            onPress={settings.reset}
          />
        ) : null}
      </SettingsSection>
    );
  }
  return <SettingsForm settings={settings} style={style} />;
}

function SettingsForm({ settings, style }: { settings: ReadySettings; style: { color: string } }) {
  const t = useText();
  const modelOptions = useModelOptions();
  const agentChoices = useMemo(
    () => agentOptions.map((option) => ({ ...option, label: t(option.label) })),
    [t],
  );
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
    <SettingsSection title={t("settings.section")}>
      <SettingsCard>
        <SettingsSelect
          label={t("settings.suggestFor")}
          hint={t("settings.suggestForHint")}
          // A list saved by an earlier build shows as is until another option is chosen.
          value={providers.length === 0 ? EVERY_AGENT : providers.join(", ")}
          options={agentChoices}
          disabled={settings.saving}
          onValueChange={changeAgents}
        />
        <SettingsSelect
          label={t("settings.model")}
          hint={t("settings.modelHint")}
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
