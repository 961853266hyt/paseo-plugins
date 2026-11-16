import type { PluginClientContext } from "@getpaseo/plugin/client";
import { initCanvas } from "./shared/rpc";
import { label } from "./client/i18n";
import { PLUGIN_ICON_SVG } from "./client/icons";
import { DesignPanel } from "./client/panel";
import { HOME_SCREEN_ID, homeScreen, HomeSidebarItem } from "./client/home";
import { PANEL_ID } from "./client/open";
import { startDesign } from "./client/start";

export default function contribute(client: PluginClientContext) {
  const cleanups = [
    client.addScreen({ id: HOME_SCREEN_ID, title: label("homeTitle"), Component: homeScreen(client) }),
    client.addSidebarHeaderItem({ id: HOME_SCREEN_ID, title: label("homeTitle"), Component: HomeSidebarItem }),
    client.addAgentPanel({
      id: PANEL_ID,
      title: label("panelTitle"),
      icon: { svg: PLUGIN_ICON_SVG },
      Component: DesignPanel,
    }),
    // `/canvas <brief>` asks this agent for a design; a bare `/canvas` just opens the canvas.
    // Not `/design`: Claude Code has its own command of that name.
    client.addSlashCommand({
      name: "canvas",
      description: label("slashDescription"),
      argumentHint: label("slashHint"),
      context: "agent",
      async onSubmit({ args, agent, workspace, paseo, rpc, openPanel }) {
        openPanel(PANEL_ID);
        const brief = args.trim();
        if (!brief) return;
        await startDesign({
          paseo,
          initCanvas: () => rpc(initCanvas, { workspaceId: workspace.id }),
          agentId: agent.id,
          brief,
        });
      },
    }),
    client.addCommandCenterItem({
      id: "open-canvas",
      title: label("openCanvas"),
      icon: { svg: PLUGIN_ICON_SVG },
      keywords: ["design", "canvas", "prototype", "mockup", "设计", "画布"],
      context: "agent",
      onSelect: ({ openPanel }) => openPanel(PANEL_ID),
    }),
    client.addCommandCenterItem({
      id: "open-home",
      title: label("openHome"),
      icon: { svg: PLUGIN_ICON_SVG },
      keywords: ["design", "designs", "home", "设计", "首页"],
      context: "global",
      onSelect: ({ openScreen }) => openScreen({ screenId: HOME_SCREEN_ID }),
    }),
  ];
  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}
