import type { PluginClientContext } from "@getpaseo/plugin/client";
import { initCanvas } from "./shared/rpc";
import { label } from "./client/i18n";
import { DesignPanel } from "./client/panel";
import { startDesign } from "./client/start";

const PANEL_ID = "design";

export default function contribute(client: PluginClientContext) {
  const cleanups = [
    client.addAgentPanel({
      id: PANEL_ID,
      title: label("panelTitle"),
      icon: "PenTool",
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
      icon: "PenTool",
      keywords: ["design", "canvas", "prototype", "mockup", "设计", "画布"],
      context: "agent",
      onSelect: ({ openPanel }) => openPanel(PANEL_ID),
    }),
  ];
  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}
