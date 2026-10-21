import { openExternalUrl, type PluginHostProps } from "@getpaseo/plugin/client";
import { ScrollView } from "@getpaseo/plugin/client/react-native";
import { Fragment, useMemo } from "react";
import { Platform, Text, View } from "react-native";
import { type Block, parseInline, parseMarkdown, type Span } from "./markdown";

type PluginTheme = PluginHostProps["theme"];

const MONOSPACE = Platform.select({
  ios: "Menlo",
  android: "monospace",
  default: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
});

export function MarkdownView({ text, theme }: { text: string; theme: PluginTheme }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  const styles = useMemo(() => buildStyles(theme), [theme]);
  return (
    <View style={styles.root}>
      {blocks.map((block, index) => (
        <BlockView key={index} block={block} styles={styles} />
      ))}
    </View>
  );
}

type Styles = ReturnType<typeof buildStyles>;

function BlockView({ block, styles }: { block: Block; styles: Styles }) {
  switch (block.kind) {
    case "paragraph":
      return <Lines lines={block.lines} style={styles.body} styles={styles} />;
    case "heading":
      return (
        <Text selectable style={[styles.body, styles.heading, block.level <= 2 && styles.headingLarge]}>
          <Inline spans={parseInline(block.text)} styles={styles} />
        </Text>
      );
    case "code":
    case "table":
      return (
        <ScrollView horizontal style={styles.codeBox} contentContainerStyle={styles.codeContent}>
          <Text selectable style={styles.codeBlock}>
            {block.kind === "code" ? block.text : block.lines.join("\n")}
          </Text>
        </ScrollView>
      );
    case "list":
      return (
        <View style={styles.list}>
          {block.items.map((item, index) => (
            <View key={index} style={[styles.listItem, { paddingLeft: item.depth * 16 }]}>
              <Text style={[styles.body, styles.marker]}>{item.marker}</Text>
              <View style={styles.listText}>
                <Lines lines={item.lines} style={styles.body} styles={styles} />
              </View>
            </View>
          ))}
        </View>
      );
    case "quote":
      return (
        <View style={styles.quote}>
          <Lines lines={block.lines} style={[styles.body, styles.muted]} styles={styles} />
        </View>
      );
    case "rule":
      return <View style={styles.rule} />;
  }
}

function Lines({
  lines,
  style,
  styles,
}: {
  lines: readonly string[];
  style: object | object[];
  styles: Styles;
}) {
  return (
    <Text selectable style={style}>
      {lines.map((line, index) => (
        <Fragment key={index}>
          {index > 0 ? "\n" : null}
          <Inline spans={parseInline(line)} styles={styles} />
        </Fragment>
      ))}
    </Text>
  );
}

function Inline({ spans, styles }: { spans: readonly Span[]; styles: Styles }) {
  return (
    <>
      {spans.map((span, index) => {
        const url = span.url;
        return (
          <Text
            key={index}
            style={[
              span.bold && styles.bold,
              span.italic && styles.italic,
              span.code && styles.inlineCode,
              url !== undefined && styles.link,
            ]}
            onPress={url === undefined ? undefined : () => void openExternalUrl(url).catch(() => undefined)}
          >
            {span.text}
          </Text>
        );
      })}
    </>
  );
}

function buildStyles(theme: PluginTheme) {
  const { colors } = theme;
  return {
    root: { gap: 8 },
    body: { color: colors.foreground, fontSize: 14, lineHeight: 20 },
    muted: { color: colors.foregroundMuted },
    heading: { fontWeight: "600" as const },
    headingLarge: { fontSize: 16, lineHeight: 22 },
    bold: { fontWeight: "600" as const },
    italic: { fontStyle: "italic" as const },
    inlineCode: {
      fontFamily: MONOSPACE,
      fontSize: 13,
      backgroundColor: colors.surface2,
      color: colors.foreground,
    },
    link: { color: colors.accent, textDecorationLine: "underline" as const },
    codeBox: {
      borderRadius: 6,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surface2,
    },
    codeContent: { paddingVertical: 8, paddingHorizontal: 10 },
    codeBlock: { fontFamily: MONOSPACE, fontSize: 12, lineHeight: 18, color: colors.foreground },
    list: { gap: 4 },
    listItem: { flexDirection: "row" as const, gap: 6 },
    marker: { minWidth: 14, color: colors.foregroundMuted },
    listText: { flex: 1 },
    quote: { borderLeftWidth: 3, borderLeftColor: colors.border, paddingLeft: 10 },
    rule: { height: 1, backgroundColor: colors.border },
  };
}
