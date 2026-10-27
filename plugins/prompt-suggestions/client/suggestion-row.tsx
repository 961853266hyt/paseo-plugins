import { type PluginTimelineItemProps, usePaseo } from "@getpaseo/plugin/client";
import { copyText, Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { useMutation } from "@tanstack/react-query";
import {
  type ComponentType,
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { AccessibilityInfo, Pressable, Text, View } from "react-native";
import type { SuggestionRow } from "../shared/suggestion-row";
import { useText } from "./i18n";
import { needsCard, type SuggestionStore } from "./suggestion-store";
import { isComposerBridgeSupported } from "./web";

type PluginTheme = PluginTimelineItemProps["theme"];

/** How long the Copy button shows its check mark after a copy. */
const COPIED_MS = 1500;

/**
 * The row carries the suggestion to this client. Where Tab can accept the composer placeholder
 * the row renders nothing; on phones, phone-sized web, or when the bridge cannot reach the
 * composer, it renders a card to tap instead.
 */
export function createSuggestionRow(
  store: SuggestionStore,
): ComponentType<PluginTimelineItemProps<SuggestionRow>> {
  return function SuggestionRowView({ agentId, item, timestamp, theme, layout }) {
    const text = item.data.status === "ready" ? item.data.text : null;
    const at = timestamp.getTime();

    useEffect(() => {
      store.setCompact(layout.compact);
    }, [layout.compact]);

    useEffect(() => {
      if (text === null) store.retire(agentId, at);
      else store.offer(agentId, text, at);
    }, [agentId, text, at]);

    const subscribe = useCallback((listener: () => void) => store.subscribe(listener), []);
    const entry = useSyncExternalStore(subscribe, () => store.get(agentId));

    const isCurrent = text !== null && entry?.text === text && entry.at === at;
    if (!isCurrent) return null;
    const placement = {
      bridgeSupported: isComposerBridgeSupported,
      compact: layout.compact,
      composer: entry.composer,
    };
    if (!needsCard(placement)) return null;
    return (
      <SuggestionCard
        agentId={agentId}
        text={text}
        theme={theme}
        onDone={() => store.remove(agentId)}
      />
    );
  };
}

interface SuggestionCardProps {
  agentId: string;
  text: string;
  theme: PluginTheme;
  onDone(): void;
}

function SuggestionCard({ agentId, text, theme, onDone }: SuggestionCardProps) {
  const paseo = usePaseo();
  const toast = useToast();
  const t = useText();
  const send = useMutation({
    mutationFn: () => paseo.agents.ref(agentId).send(text),
    onSuccess: onDone,
    onError: (error) => toast.error(t("card.sendFailed", { error: messageOf(error) })),
  });
  // A fresh timestamp per copy restarts the timer when Copy is pressed again while the check shows.
  const [copiedAt, setCopiedAt] = useState<number | null>(null);
  const copy = useMutation({
    mutationFn: () => copyText(text),
    onSuccess: () => {
      setCopiedAt(Date.now());
      AccessibilityInfo.announceForAccessibility(t("card.copiedAnnouncement"));
    },
    onError: (error) => toast.error(t("card.copyFailed", { error: messageOf(error) })),
  });
  useEffect(() => {
    if (copiedAt === null) return;
    const timer = setTimeout(() => setCopiedAt(null), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copiedAt]);
  const copied = copiedAt !== null;
  const styles = useMemo(() => buildStyles(theme), [theme]);
  const isBusy = send.isPending || copy.isPending;

  return (
    <View style={styles.card}>
      <Icon name="Lightbulb" size={14} color={theme.colors.foregroundMuted} />
      <Text style={styles.text} numberOfLines={2}>
        {text}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("card.sendLabel", { text })}
        disabled={isBusy}
        onPress={() => send.mutate()}
        style={styles.primary}
      >
        <Text style={styles.primaryLabel}>{send.isPending ? t("card.sending") : t("card.send")}</Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={copied ? t("card.copiedLabel") : t("card.copyLabel")}
        disabled={isBusy}
        onPress={() => copy.mutate()}
        style={copied ? styles.copied : styles.secondary}
      >
        {/* The label stays laid out under the check so the button keeps its size. */}
        <Text style={copied ? styles.hiddenLabel : styles.secondaryLabel}>{t("card.copy")}</Text>
        {copied ? (
          <View style={styles.copiedIcon}>
            <Icon name="Check" size={14} color={theme.colors.statusSuccess} />
          </View>
        ) : null}
      </Pressable>
    </View>
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildStyles(theme: PluginTheme) {
  const secondary = {
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: theme.colors.border,
  };
  return {
    card: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 8,
      paddingVertical: 8,
      paddingHorizontal: 12,
      borderWidth: 1,
      borderColor: theme.colors.border,
      borderRadius: 10,
      backgroundColor: theme.colors.surface1,
    },
    text: { flex: 1, color: theme.colors.foreground },
    primary: {
      paddingVertical: 6,
      paddingHorizontal: 12,
      borderRadius: 8,
      backgroundColor: theme.colors.accent,
    },
    primaryLabel: { color: theme.colors.accentForeground },
    secondary,
    secondaryLabel: { color: theme.colors.foreground },
    hiddenLabel: { color: theme.colors.foreground, opacity: 0 },
    copied: { ...secondary, borderColor: theme.colors.statusSuccess },
    copiedIcon: {
      position: "absolute" as const,
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      alignItems: "center" as const,
      justifyContent: "center" as const,
    },
  };
}
