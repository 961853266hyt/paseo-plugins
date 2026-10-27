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
import { type TextKey, useText } from "./i18n";

type ReadySettings = Extract<SettingsState<typeof sideQuestionSettings.schema>, { status: "ready" }>;

interface Option {
  label: string;
  value: string;
}

interface TextOption {
  label: TextKey;
  value: string;
}

// Claude Code aliases, so each follows the newest model of its family.
const fixedModels: TextOption[] = [
  { label: "settings.sameAsAgent", value: SAME_AS_AGENT },
  { label: "settings.latestHaiku", value: "haiku" },
  { label: "settings.latestSonnet", value: "sonnet" },
  { label: "settings.latestOpus", value: "opus" },
];

/**
 * The fixed choices, then the Claude models Paseo offers its own agents. Only the fixed choices
 * until that list loads, and if it fails.
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
  return useMemo(
    () => [...fixedModels.map((option) => ({ ...option, label: t(option.label) })), ...models],
    [models, t],
  );
}

export function SideQuestionSettingsScreen({ theme }: PluginSurfaceProps) {
  const settings = useSettings(sideQuestionSettings);
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
  const changeModel = useCallback(
    (model: string) => {
      void settings.save({ ...settings.values, model }, settings.revision);
    },
    [settings],
  );
  return (
    <SettingsSection title={t("settings.section")}>
      <SettingsCard>
        <SettingsSelect
          label={t("settings.model")}
          hint={t("settings.modelHint")}
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
