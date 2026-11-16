import {
  type PluginClientContext,
  type PluginScreenProps,
  type PluginSidebarItemProps,
  usePaseo,
  useRpc,
  useTranslation,
} from "@getpaseo/plugin/client";
import { Icon, SidebarRow, useToast } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { type ComponentType, useMemo, useState } from "react";
import { Platform, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import type { DesignKind } from "../shared/design";
import { getCover, type HomeDesign, type HomeProject, importDesign, initCanvas, listHome } from "../shared/rpc";
import { canPickFiles, fileToBase64, pickZip } from "./files";
import { messages } from "./i18n";
import { PLUGIN_ICON_SVG } from "./icons";
import { createDesign, openDesign } from "./open";
import { Thumbnail } from "./thumbnail";

export const HOME_SCREEN_ID = "home";

type Tab = "prototype" | "slides" | "other";
type Fidelity = "wireframe" | "high";
const TABS: Tab[] = ["prototype", "slides", "other"];
const CARD_MIN = 230;
const GAP = 20;
const THUMB_RATIO = 10 / 16;

type Colors = PluginScreenProps["theme"]["colors"];

export function HomeSidebarItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon={{ svg: PLUGIN_ICON_SVG }}
      active={currentScreen?.screenId === HOME_SCREEN_ID}
      onPress={() => openScreen({ screenId: HOME_SCREEN_ID })}
    />
  );
}

interface Card extends HomeDesign {
  workspaceId: string;
  directory: string;
  where: string;
}

function projectLabel(project: HomeProject): string {
  return project.workspace && project.workspace !== project.project ? `${project.project} · ${project.workspace}` : project.project;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function relativeTime(at: number, now: number, locale: string): string {
  const seconds = Math.round((at - now) / 1000);
  const steps: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 31_536_000],
    ["month", 2_592_000],
    ["week", 604_800],
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
  ];
  try {
    const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
    for (const [unit, size] of steps) {
      if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit);
    }
    return format.format(0, "minute");
  } catch {
    return new Date(at).toLocaleDateString();
  }
}

/** Pressable's web-only hover state. */
type PressState = { pressed: boolean; hovered?: boolean };

export function homeScreen(client: PluginClientContext): ComponentType<PluginScreenProps> {
  return function HomeScreen(props) {
    return <Home {...props} client={client} />;
  };
}

function Home({ theme, layout, navigation, client }: PluginScreenProps & { client: PluginClientContext }) {
  const colors = theme.colors;
  const compact = layout.compact;
  const paseo = usePaseo();
  const { t, locale } = useTranslation(messages);
  const callListHome = useRpc(listHome);
  const callInitCanvas = useRpc(initCanvas);
  const callImportDesign = useRpc(importDesign);
  const toast = useToast();

  const home = useQuery({
    queryKey: ["home"],
    queryFn: () => callListHome({}),
    refetchInterval: 8000,
  });
  const projects = home.data?.projects ?? [];

  const cards = useMemo<Card[]>(
    () =>
      projects
        .flatMap((project) =>
          project.designs.map((design) => ({ ...design, workspaceId: project.workspaceId, directory: project.directory, where: projectLabel(project) })),
        )
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [projects],
  );

  const [tab, setTab] = useState<Tab>("prototype");
  const [fidelity, setFidelity] = useState<Fidelity>("high");
  const kind: DesignKind = tab === "prototype" ? (fidelity === "wireframe" ? "wireframe" : "prototype") : tab;
  const [brief, setBrief] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<string | null>(null);

  // New designs go where the user last designed, else to the most recently active workspace.
  const target = projects.find((project) => project.workspaceId === picked) ?? projects.find((project) => project.workspaceId === cards[0]?.workspaceId) ?? projects[0] ?? null;
  const designed = projects.filter((project) => project.designs.length > 0);
  const shown = filter ? cards.filter((card) => card.workspaceId === filter) : cards;

  async function run(key: string, task: () => Promise<void>) {
    if (busy) return;
    setBusy(key);
    setError(null);
    try {
      await task();
    } catch (failure) {
      setError(t("error", { error: describe(failure) }));
    } finally {
      setBusy(null);
    }
  }

  function create() {
    const text = brief.trim();
    if (!text || !target) return;
    void run("create", async () => {
      await createDesign({
        client,
        paseo,
        navigation,
        initCanvas: () => callInitCanvas({ workspaceId: target.workspaceId }),
        workspaceId: target.workspaceId,
        known: target.designs.map((design) => design.slug),
        kind,
        brief: text,
      });
      setBrief("");
      void home.refetch();
    });
  }

  async function importZip() {
    if (!target || busy) return;
    const file = await pickZip();
    if (!file) return;
    void run("import", async () => {
      const { slug, title, kept } = await callImportDesign({ workspaceId: target.workspaceId, base64: await fileToBase64(file) });
      toast.show(kept.length ? t("designImportedKept", { title, files: kept.join(", ") }) : t("designImported", { title }));
      void home.refetch();
      await openDesign({ client, paseo, navigation, workspaceId: target.workspaceId, directory: target.directory, slug, agentId: null });
    });
  }

  function open(card: Card) {
    void run(`${card.workspaceId}/${card.slug}`, () =>
      openDesign({
        client,
        paseo,
        navigation,
        workspaceId: card.workspaceId,
        directory: card.directory,
        slug: card.slug,
        agentId: card.agentId,
      }),
    );
  }

  const styles = useMemo(() => makeStyles(colors, compact), [colors, compact]);
  const now = Date.now();

  const canCreate = brief.trim() !== "" && target !== null && busy === null;
  const newDesign = (
    <View style={styles.newColumn}>
      <View style={styles.card}>
        <View style={styles.tabs} accessibilityRole="tablist">
          {TABS.map((option) => {
            const on = option === tab;
            return (
              <Pressable
                key={option}
                accessibilityRole="tab"
                accessibilityState={{ selected: on }}
                onPress={() => setTab(option)}
                style={(state) => [styles.tab, on && styles.tabOn, !on && (state as PressState).hovered && styles.tabHover]}
              >
                <Text style={[styles.tabText, on && styles.tabTextOn]}>{t(`kind_${option}`)}</Text>
              </Pressable>
            );
          })}
        </View>

        <View style={styles.cardBody}>
          {tab === "prototype" ? (
            <View style={styles.fidelities} accessibilityRole="radiogroup">
              {(["wireframe", "high"] as const).map((option) => {
                const on = option === fidelity;
                return (
                  <Pressable
                    key={option}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: on }}
                    onPress={() => setFidelity(option)}
                    style={(state) => [styles.fidelity, on && styles.fidelityOn, !on && (state as PressState).hovered && styles.fidelityHover]}
                  >
                    <FidelityPreview kind={option} colors={colors} />
                    <Text style={[styles.fidelityText, on && styles.fidelityTextOn]}>{t(option === "high" ? "highFidelity" : "kind_wireframe")}</Text>
                  </Pressable>
                );
              })}
            </View>
          ) : null}

          <View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("project")}
              disabled={projects.length === 0}
              onPress={() => setPicking((value) => !value)}
              style={(state) => [styles.select, ((state as PressState).hovered || picking) && styles.selectHover]}
            >
              <Icon name="Folder" size={14} color={colors.foregroundMuted} />
              <Text style={styles.selectText} numberOfLines={1}>
                {target ? projectLabel(target) : home.isLoading ? "…" : t("noProjects")}
              </Text>
              <Icon name={picking ? "ChevronUp" : "ChevronDown"} size={14} color={colors.foregroundMuted} />
            </Pressable>
            {picking ? (
              <ScrollView style={styles.options} contentContainerStyle={{ padding: 4 }}>
                {projects.map((project) => (
                  <Pressable
                    key={project.workspaceId}
                    onPress={() => {
                      setPicked(project.workspaceId);
                      setPicking(false);
                    }}
                    style={(state) => [styles.option, ((state as PressState).hovered || project === target) && styles.hover]}
                  >
                    <Text style={styles.optionText} numberOfLines={1}>
                      {projectLabel(project)}
                    </Text>
                  </Pressable>
                ))}
              </ScrollView>
            ) : null}
          </View>

          <TextInput
            value={brief}
            onChangeText={setBrief}
            multiline
            placeholder={t("briefPlaceholder")}
            placeholderTextColor={colors.foregroundMuted}
            accessibilityLabel={t("briefPlaceholder")}
            style={styles.brief}
            onKeyPress={(event) => {
              const key = event.nativeEvent as { key: string; metaKey?: boolean; ctrlKey?: boolean };
              if (key.key === "Enter" && (key.metaKey || key.ctrlKey)) create();
            }}
          />
          <Pressable
            accessibilityRole="button"
            disabled={!canCreate}
            onPress={create}
            style={(state) => [styles.create, !canCreate && styles.disabled, canCreate && (state as PressState).hovered && styles.createHover]}
          >
            <Text style={styles.createText}>{busy === "create" ? "…" : t("create")}</Text>
          </Pressable>
        </View>
      </View>

      {canPickFiles ? (
        <Pressable
          accessibilityRole="button"
          disabled={!target || busy !== null}
          onPress={() => void importZip()}
          style={(state) => [styles.importLink, (!target || busy !== null) && styles.disabled, (state as PressState).hovered && styles.hover]}
        >
          <Icon name="Upload" size={14} color={colors.foregroundMuted} />
          <Text style={styles.importText}>{busy === "import" ? "…" : t("importDesign")}</Text>
        </Pressable>
      ) : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );

  return (
    <View style={styles.screen}>
      {compact ? null : newDesign}
      <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.listPane}>
        {compact ? newDesign : null}
        <View style={styles.listHeader}>
          <Text style={styles.heading}>{t("recent")}</Text>
          {designed.length > 1 ? (
            <View style={styles.filters}>
              {[null, ...designed.map((project) => project.workspaceId)].map((id) => {
                const on = filter === id;
                const project = designed.find((candidate) => candidate.workspaceId === id);
                return (
                  <Pressable
                    key={id ?? "all"}
                    onPress={() => setFilter(id)}
                    style={(state) => [styles.filter, on && styles.kindOn, !on && (state as PressState).hovered && styles.hover]}
                  >
                    <Text style={[styles.kindText, on && styles.kindTextOn]} numberOfLines={1}>
                      {project ? projectLabel(project) : t("allProjects")}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          ) : null}
        </View>
        {home.error ? <Text style={styles.error}>{t("error", { error: describe(home.error) })}</Text> : null}
        {home.data && shown.length === 0 ? <Text style={styles.muted}>{t("emptyTitle")}</Text> : null}
        <Grid
          cards={shown}
          colors={colors}
          styles={styles}
          busy={busy}
          meta={(card) => {
            const parts = [card.where, relativeTime(card.updatedAt, now, locale)];
            if (card.openComments > 0) parts.push(t("openComments", { count: card.openComments }));
            return parts.join(" · ");
          }}
          onOpen={open}
        />
      </ScrollView>
    </View>
  );
}

/** A tiny page sketch: outlines for a wireframe, filled colour for high fidelity. */
function FidelityPreview({ kind, colors }: { kind: Fidelity; colors: Colors }) {
  const wire = kind === "wireframe";
  const block = (style: object) => (wire ? { borderWidth: 1, borderColor: colors.foregroundMuted, borderStyle: "dashed" as const, ...style } : style);
  return (
    <View style={{ height: 58, borderRadius: 6, padding: 7, gap: 5, backgroundColor: colors.surface0, overflow: "hidden" }}>
      <View style={[{ height: 8, borderRadius: 2 }, block({ backgroundColor: wire ? "transparent" : colors.accent, width: "60%" })]} />
      <View style={{ flexDirection: "row", gap: 5, flex: 1 }}>
        <View style={[{ flex: 1, borderRadius: 3 }, block({ backgroundColor: wire ? "transparent" : colors.surface2 })]} />
        <View style={{ flex: 1, gap: 4 }}>
          <View style={[{ height: 4, borderRadius: 2 }, block({ backgroundColor: wire ? "transparent" : colors.foregroundMuted })]} />
          <View style={[{ height: 4, width: "70%", borderRadius: 2 }, block({ backgroundColor: wire ? "transparent" : colors.border })]} />
          <View style={[{ height: 9, width: "55%", marginTop: "auto", borderRadius: 3 }, block({ backgroundColor: wire ? "transparent" : colors.accent })]} />
        </View>
      </View>
    </View>
  );
}

function Grid({
  cards,
  colors,
  styles,
  busy,
  meta,
  onOpen,
}: {
  cards: Card[];
  colors: Colors;
  styles: Styles;
  busy: string | null;
  meta: (card: Card) => string;
  onOpen: (card: Card) => void;
}) {
  const [width, setWidth] = useState(0);
  const columns = Math.max(1, Math.floor((width + GAP) / (CARD_MIN + GAP)));
  const cardWidth = width > 0 ? Math.floor((width - GAP * (columns - 1)) / columns) : 0;
  return (
    <View style={styles.grid} onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
      {cardWidth > 0
        ? cards.map((card) => (
            <DesignCard
              key={`${card.workspaceId}/${card.slug}`}
              card={card}
              width={cardWidth}
              colors={colors}
              styles={styles}
              opening={busy === `${card.workspaceId}/${card.slug}`}
              meta={meta(card)}
              onOpen={() => onOpen(card)}
            />
          ))
        : null}
    </View>
  );
}

function DesignCard({
  card,
  width,
  colors,
  styles,
  opening,
  meta,
  onOpen,
}: {
  card: Card;
  width: number;
  colors: Colors;
  styles: Styles;
  opening: boolean;
  meta: string;
  onOpen: () => void;
}) {
  const callGetCover = useRpc(getCover);
  const cover = useQuery({
    queryKey: ["cover", card.workspaceId, card.slug, card.updatedAt],
    queryFn: () => callGetCover({ workspaceId: card.workspaceId, slug: card.slug }),
    enabled: Platform.OS === "web" && card.error === null,
    staleTime: Infinity,
    placeholderData: (previous) => previous,
  });
  const thumbHeight = Math.round(width * THUMB_RATIO);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={card.title}
      onPress={onOpen}
      style={(state) => [{ width, opacity: opening ? 0.6 : 1 }]}
    >
      {(state) => (
        <>
          <View style={[styles.thumb, (state as PressState).hovered && styles.thumbHover]}>
            <Thumbnail cover={cover.data?.cover ?? null} width={width - 2} height={thumbHeight} background={colors.surface2} />
          </View>
          <Text style={styles.cardTitle} numberOfLines={1}>
            {card.title}
          </Text>
          <Text style={styles.cardMeta} numberOfLines={1}>
            {card.error ?? meta}
          </Text>
        </>
      )}
    </Pressable>
  );
}

type Styles = ReturnType<typeof makeStyles>;

function makeStyles(colors: Colors, compact: boolean) {
  return {
    screen: { flex: 1, flexDirection: "row" as const, backgroundColor: colors.surface0 },
    newColumn: {
      width: compact ? undefined : 340,
      padding: compact ? 0 : 24,
      paddingBottom: compact ? 8 : 24,
      gap: 10,
      borderRightWidth: compact ? 0 : 1,
      borderColor: colors.border,
    },
    card: { borderRadius: 12, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface1, overflow: "hidden" as const },
    tabs: { flexDirection: "row" as const, borderBottomWidth: 1, borderColor: colors.border, paddingHorizontal: 6 },
    tab: { flex: 1, height: 40, alignItems: "center" as const, justifyContent: "center" as const, borderBottomWidth: 2, borderColor: "transparent", marginBottom: -1 },
    tabOn: { borderColor: colors.foreground },
    tabHover: { borderColor: colors.border },
    tabText: { color: colors.foregroundMuted, fontSize: 13, fontWeight: "500" as const },
    tabTextOn: { color: colors.foreground },
    cardBody: { padding: 12, gap: 10 },
    fidelities: { flexDirection: "row" as const, gap: 8 },
    fidelity: { flex: 1, padding: 6, gap: 6, borderRadius: 9, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface1 },
    fidelityOn: { borderColor: colors.foreground, borderWidth: 1.5, padding: 5.5 },
    fidelityHover: { borderColor: colors.foregroundMuted },
    fidelityText: { color: colors.foregroundMuted, fontSize: 12, textAlign: "center" as const, paddingBottom: 2 },
    fidelityTextOn: { color: colors.foreground, fontWeight: "500" as const },
    importLink: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      alignSelf: "flex-start" as const,
      gap: 6,
      height: 30,
      paddingHorizontal: 8,
      marginLeft: -8,
      borderRadius: 6,
    },
    importText: { color: colors.foregroundMuted, fontSize: 13 },
    listPane: { padding: compact ? 16 : 24, gap: 16 },
    heading: { color: colors.foreground, fontSize: 17, fontWeight: "600" as const },
    muted: { color: colors.foregroundMuted, fontSize: 13 },
    kindOn: { backgroundColor: colors.foreground, borderColor: colors.foreground },
    kindText: { color: colors.foreground, fontSize: 13 },
    kindTextOn: { color: colors.surface0 },
    hover: { backgroundColor: colors.surface2 },
    select: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 8,
      height: 34,
      paddingHorizontal: 10,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surface0,
    },
    selectHover: { borderColor: colors.foregroundMuted },
    selectText: { flex: 1, color: colors.foreground, fontSize: 13 },
    options: { maxHeight: 240, marginTop: 4, borderRadius: 8, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface1 },
    option: { height: 32, justifyContent: "center" as const, paddingHorizontal: 8, borderRadius: 6 },
    optionText: { color: colors.foreground, fontSize: 13 },
    brief: {
      minHeight: compact ? 88 : 112,
      padding: 10,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surface0,
      color: colors.foreground,
      fontSize: 14,
      lineHeight: 20,
      textAlignVertical: "top" as const,
    },
    create: { height: 36, borderRadius: 8, alignItems: "center" as const, justifyContent: "center" as const, backgroundColor: colors.accent },
    createHover: { opacity: 0.9 },
    createText: { color: colors.accentForeground, fontSize: 14, fontWeight: "600" as const },
    disabled: { opacity: 0.45 },
    error: { color: colors.statusDanger, fontSize: 13 },
    listHeader: { gap: 10 },
    filters: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 6 },
    filter: { paddingHorizontal: 10, height: 26, justifyContent: "center" as const, borderRadius: 13, borderWidth: 1, borderColor: colors.border, maxWidth: 260 },
    grid: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: GAP },
    thumb: { borderRadius: 10, borderWidth: 1, borderColor: colors.border, overflow: "hidden" as const, backgroundColor: colors.surface2 },
    thumbHover: { borderColor: colors.foregroundMuted },
    cardTitle: { color: colors.foreground, fontSize: 14, fontWeight: "500" as const, marginTop: 8 },
    cardMeta: { color: colors.foregroundMuted, fontSize: 12, marginTop: 2 },
  };
}
