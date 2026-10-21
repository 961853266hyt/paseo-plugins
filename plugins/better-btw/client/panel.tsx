import type { PluginAgentPanelProps, PluginHostProps } from "@getpaseo/plugin/client";
import { ScrollView } from "@getpaseo/plugin/client/react-native";
import { useMemo } from "react";
import { View } from "react-native";
import { AskBox } from "./ask-box";
import { ThreadView } from "./thread-view";

type PluginTheme = PluginHostProps["theme"];

/**
 * The agent's side thread beside its chat, with a box for the next question, as Claude Code's
 * VS Code extension does it. /btw opens it in the Explorer sidebar on the wide web and desktop app.
 */
export function SideQuestionPanel({ agentId, theme }: PluginAgentPanelProps) {
  const styles = useMemo(() => buildStyles(theme), [theme]);
  return (
    <View style={styles.root}>
      <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
        <ThreadView agentId={agentId} theme={theme} />
      </ScrollView>
      <View style={styles.composer}>
        <AskBox agentId={agentId} theme={theme} />
      </View>
    </View>
  );
}

function buildStyles(theme: PluginTheme) {
  return {
    root: { flex: 1 },
    scroll: { flex: 1 },
    content: { padding: 16 },
    composer: { borderTopWidth: 1, borderTopColor: theme.colors.border, padding: 12 },
  };
}
