import {
  type PluginAgentPanelProps,
  useAgent,
  usePaseo,
  useRpc,
  useTabState,
  useTranslation,
} from "@getpaseo/plugin/client";
import { useEffect, useMemo, useRef } from "react";
import { Platform, Text, View } from "react-native";
import { z } from "zod";
import {
  addComment,
  deleteComment,
  deleteDesign,
  editText,
  renameDesign,
  getDesign,
  getDesignVersion,
  initCanvas,
  listDesigns,
  markCommentsSent,
  moveArtboard,
  moveElement,
  saveTweaks,
  updateComment,
} from "../shared/rpc";
import { type CanvasApi, type CanvasHandle, mountCanvas, type Translate } from "./canvas";
import { messages } from "./i18n";
import { startDesign } from "./start";

const tabStateSchema = z.object({ slug: z.string().nullable() });

export function DesignPanel({ theme, workspaceId, params, tab }: PluginAgentPanelProps) {
  const agentId = params.agentId;
  const paseo = usePaseo();
  const { t, locale } = useTranslation(messages);
  const [tabState, setTabState] = useTabState(tab, tabStateSchema, { slug: null });
  const status = useAgent(agentId, (agent) => ({ status: agent.status }))?.status ?? null;

  const calls = {
    listDesigns: useRpc(listDesigns),
    getDesign: useRpc(getDesign),
    getDesignVersion: useRpc(getDesignVersion),
    addComment: useRpc(addComment),
    updateComment: useRpc(updateComment),
    deleteComment: useRpc(deleteComment),
    markCommentsSent: useRpc(markCommentsSent),
    initCanvas: useRpc(initCanvas),
    moveElement: useRpc(moveElement),
    moveArtboard: useRpc(moveArtboard),
    editText: useRpc(editText),
    saveTweaks: useRpc(saveTweaks),
    deleteDesign: useRpc(deleteDesign),
    renameDesign: useRpc(renameDesign),
  };
  // The canvas mounts once per agent; it reads the latest functions through this ref.
  const latest = useRef({ calls, paseo, setTabState });
  latest.current = { calls, paseo, setTabState };

  const hostRef = useRef<View>(null);
  const handleRef = useRef<CanvasHandle | null>(null);
  const initialSlug = useRef(tabState.slug);

  const api = useMemo<CanvasApi>(
    () => ({
      listDesigns: () => latest.current.calls.listDesigns({ workspaceId }),
      getDesign: (slug) => latest.current.calls.getDesign({ workspaceId, slug }),
      getDesignVersion: async (slug) => (await latest.current.calls.getDesignVersion({ workspaceId, slug })).version,
      addComment: async (slug, body, anchor) => (await latest.current.calls.addComment({ workspaceId, slug, body, anchor })).comment,
      updateComment: async (slug, id, patch) => (await latest.current.calls.updateComment({ workspaceId, slug, id, ...patch })).comment,
      deleteComment: async (slug, id) => {
        await latest.current.calls.deleteComment({ workspaceId, slug, id });
      },
      markSent: async (slug, ids) => {
        await latest.current.calls.markCommentsSent({ workspaceId, slug, ids });
      },
      moveElement: (slug, artboardId, dcId, style, expected) =>
        latest.current.calls.moveElement({ workspaceId, slug, artboardId, dcId, style, expected }),
      editText: (slug, artboardId, target, before, after, expected) =>
        latest.current.calls.editText({ workspaceId, slug, artboardId, target, before, after, expected }),
      renameDesign: async (slug, title) => {
        await latest.current.calls.renameDesign({ workspaceId, slug, title });
      },
      deleteDesign: async (slug) => (await latest.current.calls.deleteDesign({ workspaceId, slug })).trashedTo,
      saveTweaks: (slug, values) => latest.current.calls.saveTweaks({ workspaceId, slug, values }),
      moveArtboard: async (slug, artboardId, position) => {
        await latest.current.calls.moveArtboard({ workspaceId, slug, artboardId, position });
      },
      sendToAgent: (text) => latest.current.paseo.agents.ref(agentId).send(text),
      startDesign: (brief) =>
        startDesign({
          paseo: latest.current.paseo,
          initCanvas: () => latest.current.calls.initCanvas({ workspaceId }),
          agentId,
          brief,
        }),
    }),
    [workspaceId, agentId],
  );

  useEffect(() => {
    if (Platform.OS !== "web") return;
    const host = hostRef.current as unknown as HTMLElement | null;
    if (!host) return;
    const handle = mountCanvas({
      host,
      t: t as unknown as Translate,
      api,
      theme: theme.colors,
      initialSlug: initialSlug.current,
      onSlugChange: (slug) => {
        initialSlug.current = slug;
        latest.current.setTabState({ slug });
      },
    });
    handleRef.current = handle;
    return () => {
      handle.destroy();
      handleRef.current = null;
    };
    // Remount for another agent, workspace or language; theme and status are pushed below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, locale]);

  useEffect(() => {
    handleRef.current?.setTheme(theme.colors);
  }, [theme]);

  useEffect(() => {
    handleRef.current?.setAgentStatus(status);
  }, [status, api, locale]);

  if (Platform.OS !== "web") {
    return (
      <View style={{ flex: 1, padding: 24, backgroundColor: theme.colors.surface0 }}>
        <Text style={{ color: theme.colors.foregroundMuted }}>{t("nativeUnsupported")}</Text>
      </View>
    );
  }
  return <View ref={hostRef} style={{ flex: 1, position: "relative", overflow: "hidden" }} />;
}
