import type { PluginAgentCommandContext, PluginClientContext } from "@getpaseo/plugin/client";
import { announceAsked } from "./client/asked";
import { label, textNow } from "./client/i18n";
import { canOpenBesideChat } from "./client/layout";
import { SideQuestionPanel } from "./client/panel";
import { createPillManager, SIDE_QUESTION_ICON } from "./client/pills";
import { SideQuestionSettingsScreen } from "./client/settings-screen";
import { askSideQuestion, getThread } from "./shared/thread";

const PANEL_ID = "side-questions";

type OpenPanel = PluginAgentCommandContext["openPanel"];

/** Opens the panel in the Explorer sidebar where the app can draw it there; false otherwise. */
function openBesideChat(openPanel: OpenPanel): boolean {
  if (!canOpenBesideChat()) return false;
  try {
    openPanel(PANEL_ID, { location: "explorer" });
    return true;
  } catch (error) {
    console.warn("[better-btw] Could not open the panel beside the chat", error);
    return false;
  }
}

export default function contribute(client: PluginClientContext) {
  const pills = createPillManager(client);

  client.addWorkspacePanel({
    id: PANEL_ID,
    title: label("panelTitle"),
    icon: SIDE_QUESTION_ICON,
    context: "agent",
    // The Explorer sidebar keeps the thread beside the chat; the main area takes it when moved there.
    locations: ["explorer", "workspace"],
    Component: SideQuestionPanel,
  });

  // Paseo runs plugin commands in the app and never sends their text to the agent, even mid-turn.
  client.addSlashCommand({
    name: "btw",
    description: label("commandDescription"),
    argumentHint: label("commandArgument"),
    context: "agent",
    async onSubmit({ args, agent, workspace, rpc, openPanel }) {
      if (args) {
        await rpc(askSideQuestion, { agentId: agent.id, question: args });
        announceAsked(agent.id);
      } else {
        // Like Claude Code, /btw alone reopens the latest side question, so there has to be one.
        // Beside a wide chat the panel opens anyway, since its box can ask the first one.
        const thread = await rpc(getThread, { agentId: agent.id, focusId: null });
        if (thread.exchanges.length === 0) {
          if (!openBesideChat(openPanel)) throw new Error(textNow(client, "usage"));
          return;
        }
      }
      // The pill always shows: focus mode hides the Explorer sidebar, and a plugin cannot tell.
      pills.show(workspace.id, agent.id);
      openBesideChat(openPanel);
    },
  });

  client.addCommandCenterItem({
    id: "side-questions",
    title: label("commandCenterTitle"),
    icon: SIDE_QUESTION_ICON,
    keywords: ["btw", "side question", "ask"],
    context: "agent",
    onSelect({ openPanel, workspace, agent }) {
      if (openBesideChat(openPanel)) {
        pills.show(workspace.id, agent.id);
        return;
      }
      // Elsewhere the panel takes the main area, where every layout shows it.
      openPanel(PANEL_ID, { location: "workspace" });
    },
  });

  client.addSettingsScreen({
    id: "settings",
    // The menu item sits in this plugin's own menu, so it names the action, not the plugin.
    title: label("settingsScreen"),
    icon: "Settings",
    Component: SideQuestionSettingsScreen,
  });

  return () => pills.dispose();
}
