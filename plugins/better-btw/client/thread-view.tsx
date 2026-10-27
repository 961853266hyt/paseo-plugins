import { type PluginHostProps, useRpc } from "@getpaseo/plugin/client";
import { copyText, Icon, useRevealedText, useToast } from "@getpaseo/plugin/client/react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { AccessibilityInfo, ActivityIndicator, Pressable, Text, View } from "react-native";
import {
  clearSideQuestions,
  type Exchange,
  type ExchangeSummary,
  getThread,
  stopSideQuestion,
} from "../shared/thread";
import { onAsked } from "./asked";
import { useText } from "./i18n";
import { MarkdownView } from "./markdown-view";

type PluginTheme = PluginHostProps["theme"];

/** Polling stands in for streaming: plugins have no push channel that leaves the timeline alone. */
const ANSWERING_POLL_MS = 400;
/** Picks up side questions asked from another client of the same host. */
const IDLE_POLL_MS = 4_000;
/** Like Claude Code, list the five newest other side questions; the rest are counted. */
const LISTED_OTHERS = 5;
/** How long Copy shows its check mark. */
const COPIED_MS = 1500;

export function threadQueryKey(agentId: string) {
  return ["side-questions", "thread", agentId] as const;
}

export interface ThreadViewProps {
  agentId: string;
  theme: PluginTheme;
  /** Only in the composer pill's sheet: hides the pill until the next /btw. */
  onDismiss?(): void;
}

export function ThreadView({ agentId, theme, onDismiss }: ThreadViewProps) {
  const fetchThread = useRpc(getThread);
  const clear = useRpc(clearSideQuestions);
  const queryClient = useQueryClient();
  const toast = useToast();
  const t = useText();
  const [focusId, setFocusId] = useState<string | null>(null);
  const styles = useMemo(() => buildStyles(theme), [theme]);

  const query = useQuery({
    queryKey: [...threadQueryKey(agentId), focusId],
    queryFn: () => fetchThread({ agentId, focusId }),
    refetchInterval: ({ state }) =>
      state.data?.exchanges.some((exchange) => exchange.status === "answering")
        ? ANSWERING_POLL_MS
        : IDLE_POLL_MS,
  });

  useEffect(
    () =>
      onAsked((asked) => {
        if (asked !== agentId) return;
        setFocusId(null);
        void queryClient.invalidateQueries({ queryKey: threadQueryKey(agentId) });
      }),
    [agentId, queryClient],
  );

  const clearEarlier = useMutation({
    mutationFn: () => clear({ agentId }),
    onSuccess: () => {
      setFocusId(null);
      void queryClient.invalidateQueries({ queryKey: threadQueryKey(agentId) });
    },
    onError: (error) => toast.error(t("thread.clearFailed", { error: messageOf(error) })),
  });

  const thread = query.data;
  if (!thread) {
    if (query.isError) {
      return (
        <Text style={styles.muted}>
          {t("thread.loadFailed", { error: messageOf(query.error) })}
        </Text>
      );
    }
    return <ActivityIndicator color={theme.colors.foregroundMuted} />;
  }
  const focus = thread.focus;
  if (!focus) {
    return (
      <View style={styles.empty}>
        <Text style={styles.title}>{t("thread.emptyTitle")}</Text>
        <Text style={styles.muted}>{t("thread.emptyBody")}</Text>
      </View>
    );
  }

  const others = thread.exchanges.filter((exchange) => exchange.id !== focus.id);
  const listed = others.slice(-LISTED_OTHERS);
  const isLatest = thread.exchanges.at(-1)?.id === focus.id;
  return (
    <View style={styles.root}>
      {others.length > listed.length ? (
        <Text style={styles.muted}>
          {t("thread.earlier", { number: String(others.length - listed.length) })}
        </Text>
      ) : null}
      {listed.map((exchange) => (
        <OtherQuestion
          key={exchange.id}
          exchange={exchange}
          styles={styles}
          onPress={() => setFocusId(exchange.id)}
        />
      ))}
      <ExchangeView
        key={focus.id}
        agentId={agentId}
        exchange={focus}
        theme={theme}
        styles={styles}
        onDismiss={onDismiss}
        footer={
          <>
            {isLatest ? null : (
              <Action
                label={t("thread.latest")}
                icon="CornerDownRight"
                styles={styles}
                theme={theme}
                onPress={() => setFocusId(null)}
              />
            )}
            {others.length > 0 ? (
              <Action
                label={t("thread.clearEarlier")}
                icon="Eraser"
                styles={styles}
                theme={theme}
                disabled={clearEarlier.isPending}
                onPress={() => clearEarlier.mutate()}
              />
            ) : null}
          </>
        }
      />
    </View>
  );
}

type Styles = ReturnType<typeof buildStyles>;

function OtherQuestion({
  exchange,
  styles,
  onPress,
}: {
  exchange: ExchangeSummary;
  styles: Styles;
  onPress(): void;
}) {
  const t = useText();
  const pending = exchange.status === "answering" ? t("thread.answeringSuffix") : "";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t("thread.showQuestion", { question: exchange.question })}
      onPress={onPress}
    >
      <Text style={styles.muted} numberOfLines={1}>
        ❯ {exchange.question}
        {pending}
      </Text>
    </Pressable>
  );
}

interface ExchangeViewProps {
  agentId: string;
  exchange: Exchange;
  theme: PluginTheme;
  styles: Styles;
  onDismiss?(): void;
  footer: ReactNode;
}

function ExchangeView({ agentId, exchange, theme, styles, onDismiss, footer }: ExchangeViewProps) {
  const stop = useRpc(stopSideQuestion);
  const queryClient = useQueryClient();
  const toast = useToast();
  const t = useText();
  const answering = exchange.status === "answering";
  const answer = useRevealedText(exchange.answer, answering ? "streaming" : "complete");

  const stopAnswer = useMutation({
    mutationFn: () => stop({ agentId, exchangeId: exchange.id }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: threadQueryKey(agentId) }),
    onError: (error) => toast.error(t("thread.stopFailed", { error: messageOf(error) })),
  });

  // A fresh timestamp per copy restarts the timer when Copy is pressed again while the check shows.
  const [copiedAt, setCopiedAt] = useState<number | null>(null);
  const copy = useMutation({
    mutationFn: () => copyText(exchange.answer),
    onSuccess: () => {
      setCopiedAt(Date.now());
      AccessibilityInfo.announceForAccessibility(t("thread.copiedAnnouncement"));
    },
    onError: (error) => toast.error(t("thread.copyFailed", { error: messageOf(error) })),
  });
  useEffect(() => {
    if (copiedAt === null) return;
    const timer = setTimeout(() => setCopiedAt(null), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copiedAt]);

  return (
    <View style={styles.exchange}>
      <View style={styles.questionRow}>
        <Text selectable style={[styles.title, styles.question]}>
          ❯ {exchange.question}
        </Text>
        {onDismiss ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("thread.dismiss")}
            hitSlop={8}
            onPress={onDismiss}
          >
            <Icon name="X" size={16} color={theme.colors.foregroundMuted} />
          </Pressable>
        ) : null}
      </View>
      {answer ? <MarkdownView text={answer} theme={theme} /> : null}
      {answering && !answer ? (
        <View style={styles.status}>
          <ActivityIndicator size="small" color={theme.colors.foregroundMuted} />
          <Text style={styles.muted}>{t("thread.answering")}</Text>
        </View>
      ) : null}
      {exchange.status === "failed" ? (
        <Text selectable style={styles.error}>
          {exchange.error ?? t("thread.noAnswer")}
        </Text>
      ) : null}
      {exchange.status === "stopped" ? (
        <Text style={styles.muted}>{t("thread.stopped")}</Text>
      ) : null}
      <View style={styles.footer}>
        {exchange.model ? (
          <Text style={[styles.muted, styles.model]} numberOfLines={1}>
            {exchange.model}
          </Text>
        ) : null}
        {answering ? (
          <Action
            label={t("thread.stop")}
            icon="CircleStop"
            styles={styles}
            theme={theme}
            disabled={stopAnswer.isPending}
            onPress={() => stopAnswer.mutate()}
          />
        ) : null}
        {exchange.answer && !answering ? (
          <Action
            label={copiedAt === null ? t("thread.copy") : t("thread.copied")}
            icon={copiedAt === null ? "Copy" : "Check"}
            styles={styles}
            theme={theme}
            iconColor={copiedAt === null ? undefined : theme.colors.statusSuccess}
            disabled={copy.isPending}
            onPress={() => copy.mutate()}
          />
        ) : null}
        {footer}
      </View>
    </View>
  );
}

function Action({
  label,
  icon,
  styles,
  theme,
  iconColor,
  disabled,
  onPress,
}: {
  label: string;
  icon: string;
  styles: Styles;
  theme: PluginTheme;
  iconColor?: string;
  disabled?: boolean;
  onPress(): void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={styles.action}
    >
      <Icon name={icon} size={13} color={iconColor ?? theme.colors.foregroundMuted} />
      <Text style={styles.actionLabel}>{label}</Text>
    </Pressable>
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildStyles(theme: PluginTheme) {
  const { colors } = theme;
  return {
    root: { gap: 6 },
    empty: { gap: 6 },
    title: { color: colors.foreground, fontSize: 14, fontWeight: "600" as const },
    muted: { color: colors.foregroundMuted, fontSize: 13, lineHeight: 18 },
    error: { color: colors.statusDanger, fontSize: 13, lineHeight: 18 },
    exchange: { gap: 10, marginTop: 4 },
    questionRow: { flexDirection: "row" as const, alignItems: "flex-start" as const, gap: 8 },
    question: { flex: 1, lineHeight: 20 },
    status: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
    footer: {
      flexDirection: "row" as const,
      flexWrap: "wrap" as const,
      alignItems: "center" as const,
      columnGap: 14,
      rowGap: 6,
    },
    model: { flexShrink: 1 },
    action: { flexDirection: "row" as const, alignItems: "center" as const, gap: 4, paddingVertical: 2 },
    actionLabel: { color: colors.foregroundMuted, fontSize: 13 },
  };
}
