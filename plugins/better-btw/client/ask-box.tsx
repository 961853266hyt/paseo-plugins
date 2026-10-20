import { type PluginHostProps, useRpc } from "@getpaseo/plugin/client";
import { Icon, TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { useMutation } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Pressable, View } from "react-native";
import { askSideQuestion } from "../shared/thread";
import { announceAsked } from "./asked";

type PluginTheme = PluginHostProps["theme"];

/** Asks the next side question without going back to the agent's message box. */
export function AskBox({ agentId, theme }: { agentId: string; theme: PluginTheme }) {
  const ask = useRpc(askSideQuestion);
  const toast = useToast();
  const [text, setText] = useState("");
  const styles = useMemo(() => buildStyles(theme), [theme]);
  const send = useMutation({
    mutationFn: (question: string) => ask({ agentId, question }),
    onSuccess: () => {
      setText("");
      announceAsked(agentId);
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : String(error)),
  });
  const question = text.trim();
  const canSend = question.length > 0 && !send.isPending;
  const submit = () => {
    if (canSend) send.mutate(question);
  };
  return (
    <View style={styles.row}>
      <TextInput
        value={text}
        onChangeText={setText}
        onSubmitEditing={submit}
        submitBehavior="submit"
        returnKeyType="send"
        placeholder="Ask a side question…"
        placeholderTextColor={theme.colors.foregroundMuted}
        accessibilityLabel="Side question"
        style={styles.input}
      />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Ask side question"
        disabled={!canSend}
        onPress={submit}
        style={[styles.send, !canSend && styles.sendDisabled]}
      >
        <Icon name="ArrowUp" size={16} color={theme.colors.accentForeground} />
      </Pressable>
    </View>
  );
}

function buildStyles(theme: PluginTheme) {
  const { colors } = theme;
  return {
    row: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
    input: {
      flex: 1,
      minHeight: 36,
      paddingHorizontal: 10,
      paddingVertical: 8,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 8,
      backgroundColor: colors.surface1,
      color: colors.foreground,
      fontSize: 14,
    },
    send: {
      width: 32,
      height: 32,
      borderRadius: 16,
      alignItems: "center" as const,
      justifyContent: "center" as const,
      backgroundColor: colors.accent,
    },
    sendDisabled: { opacity: 0.4 },
  };
}
